#!/usr/bin/env python3
"""Supervise an isolated Dot sidecar and memory-only existing-account transport."""
import argparse,base64,fcntl,grp,hashlib,http.client,json,os,select,signal,socket,stat,subprocess,threading,time
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ['repo','state','deps','chromium','codex','auth-file','target-file']:p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--parent-origin',required=True)
a=p.parse_args(); repo=a.repo.resolve(); state=a.state.resolve();state.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(state,0o700)
# systemd KillMode=control-group reaps the old lifetime before restarting us.
# The lock additionally rejects concurrent manual supervisors.
lock_fd=os.open(state/'runtime.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
def stale_socket(path):
 try:metadata=path.lstat()
 except FileNotFoundError:return
 if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid!=os.getuid():raise RuntimeError('Unexpected runtime socket owner or type')
 path.unlink()
for directory in [state/'transport',state/'browser',state/'app']:
 for path in directory.glob('*.sock'):stale_socket(path)
room=json.loads(a.target_file.read_text())['selection']['messaging_room_id']
stop=False
children=[]
# This ingress is owned by nginx's group; all transports stay owner-only.
public=Path('/run/codex-dot');public.mkdir(mode=0o750,exist_ok=True)
os.chown(public,0,grp.getgrnam('www').gr_gid);os.chmod(public,0o750)
public_socket=public/'http.sock'
stale_socket(public_socket)
ingress=socket.socket(socket.AF_UNIX);ingress.bind(str(public_socket));os.chown(public_socket,0,grp.getgrnam('www').gr_gid);os.chmod(public_socket,0o660);ingress.listen(128)
def forward(client):
 upstream=socket.socket(socket.AF_UNIX)
 try:
  upstream.connect(str(state/'app/ingress.sock'))
  while not stop:
   ready,_,_=select.select([client,upstream],[],[],10)
   for stream in ready:
    data=stream.recv(65536)
    if not data:return
    (upstream if stream is client else client).sendall(data)
 except OSError:pass
 finally:client.close();upstream.close()
def serve():
 while not stop:
  try:client,_=ingress.accept()
  except OSError:return
  threading.Thread(target=forward,args=(client,),daemon=True).start()
threading.Thread(target=serve,daemon=True).start()
def halt(*_):
 global stop
 stop=True
signal.signal(signal.SIGTERM,halt);signal.signal(signal.SIGINT,halt)
def auth():
 raw=a.auth_file.read_bytes();v=json.loads(raw)['tokens'];token=v['access_token'];exp=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='))['exp']
 if exp<=time.time():raise ValueError('expired')
 return hashlib.sha256(raw).digest()
def status(value):
 (state/'runtime-status.json').write_text(json.dumps({'status':value,'updated':int(time.time())}))
def launch(command,env=None):
 child=subprocess.Popen(command,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True);children.append(child);return child
def cleanup():
 for child in reversed(children):
  if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
 for child in children:
  try:child.wait(timeout=4)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 children.clear()
 for directory in [state/'transport',state/'browser',state/'app']:
  for f in directory.glob('*.sock'):f.unlink(missing_ok=True)
def wait_for(path,timeout=60):
 end=time.time()+timeout
 while time.time()<end and not stop:
  if any(c.poll() is not None for c in children):raise RuntimeError('Child exited')
  if path.exists():return
  time.sleep(.2)
 raise RuntimeError('Readiness timeout')
def private_get(path,url,headers=None):
 connection=http.client.HTTPConnection('localhost',timeout=12);connection.sock=socket.socket(socket.AF_UNIX);connection.sock.settimeout(12)
 try:
  connection.sock.connect(str(path));connection.request('GET',url,headers=headers or {});response=connection.getresponse();data=response.read(1024*1024)
  if response.status!=200:raise RuntimeError('Authenticated transport unavailable')
  return json.loads(data)
 finally:connection.close()
def transport_health():
 browser=json.loads((state/'browser/status.json').read_text())
 if not browser.get('browserConnected'):raise RuntimeError('Browser disconnected')
 token=private_get(state/'transport/auth.sock','/external-auth')
 selection=private_get(state/'transport/fetch.sock','/backend-api/tbo/primary',{'Authorization':'Bearer '+token['accessToken'],'ChatGPT-Account-Id':token['chatgptAccountId']})
 if selection.get('selection',{}).get('messaging_room_id')!=room:raise RuntimeError('Account Dot selection changed; explicit target reconciliation required')
def namespace(mounts,env,command):
 args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv']
 for source,target in mounts:args+=['--ro-bind',str(source),str(target)]
 args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp']
 for k,v in env.items():args+=['--setenv',k,str(v)]
 return args+command
for d in ['transport','browser','app']:(state/d).mkdir(mode=0o700,exist_ok=True)
for d in ['home','codex','config','data','cache','workspace']:(state/'app'/d).mkdir(exist_ok=True)
(state/'hosts').write_text('127.0.0.1 localhost chatgpt.com\n')
common=[(x,x) for x in ['/usr','/lib','/lib64','/etc/fonts'] if Path(x).exists()]
try:
 while not stop:
  try:
   fingerprint=auth();status('starting')
   env=dict(os.environ,DOT_BROWSER_STATE=str(state/'browser'),DOT_SOURCE_AUTH=str(a.auth_file))
   launch(['/usr/local/bin/node',str(repo/'scripts/dot-runtime-browser.cjs')],env)
   wait_for(state/'browser/egress.sock')
   mounts=common+[('/bin','/bin'),('/sbin','/sbin'),('/etc/ssl/certs','/etc/ssl/certs'),('/etc/ld.so.cache','/etc/ld.so.cache'),(a.chromium.resolve().parent,'/browser'),(repo/'scripts/dot-runtime-browser-inside.py','/inside.py')]
   cmd=namespace(mounts,{'PATH':'/usr/bin:/bin','HOME':'/state/home','DISPLAY':':99','LANG':'C.UTF-8'},['--bind',str(state/'browser'),'/state','--','/usr/bin/python3','/inside.py'])
   launch(cmd);wait_for(state/'browser/cdp.sock')
   end=time.time()+90
   while time.time()<end:
    if stop:break
    if any(c.poll() is not None for c in children):raise RuntimeError('Browser exited')
    try:
     if json.loads((state/'browser/status.json').read_text()).get('responseStatus')==200:break
    except (FileNotFoundError,json.JSONDecodeError):pass
    time.sleep(.5)
   else:raise RuntimeError('Official browser authentication unavailable')
   launch(['/usr/local/bin/node',str(repo/'scripts/dot-readonly-auth.cjs'),'--auth-file',str(a.auth_file),'--listen-socket',str(state/'transport/auth.sock')])
   relay_env=dict(os.environ,CODEX_DOT_MESSAGE_ROOM_ID=room,CODEX_DOT_MESSAGE_LEDGER_FILE=str(state/'message-ledger.jsonl'))
   launch(['/usr/local/bin/node',str(repo/'scripts/dot-browser-fetch-relay.cjs'),'--cdp-socket',str(state/'browser/cdp.sock'),'--listen-socket',str(state/'transport/fetch.sock')],relay_env)
   wait_for(state/'transport/auth.sock');wait_for(state/'transport/fetch.sock')
   mounts=common+[(repo,'/app'),(a.deps.resolve(),'/deps'),(a.codex.resolve(),'/bin/codex-real'),('/usr/bin/sh','/bin/sh'),('/usr/bin/bash','/bin/bash'),(state/'hosts','/etc/hosts')]+[(state/'transport'/f'{n}.sock',f'/run/dot/{n}.sock') for n in ['auth','fetch']]
   modules=repo/'node_modules';mounts.append((a.deps.resolve(),str(modules.resolve()) if modules.is_symlink() else '/app/node_modules'))
   env={'PATH':'/bin:/usr/local/bin:/usr/bin','NODE_PATH':'/deps','HOME':'/state/home','CODEX_HOME':'/state/codex','XDG_CONFIG_HOME':'/state/config','XDG_DATA_HOME':'/state/data','XDG_CACHE_HOME':'/state/cache','CODEX_CLI_PATH':'/app/scripts/dot-external-auth-cli.cjs','CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH':'/bin/codex-real','CODEX_BROWSER_FETCH_RELAY_SOCKET':'/run/dot/fetch.sock','DOT_AUTH_BASE_URL':'https://127.0.0.1:443/backend-api','CODEX_DOT_MESSAGE_ROOM_ID':room,'CODEX_DOT_EMBED_PARENT_ORIGIN':a.parent_origin}
   launch(namespace(mounts,env,['--tmpfs','/app/.local','--bind',str(state/'app'),'/state','--chdir','/state/workspace','--','/usr/local/bin/node','/app/scripts/dot-runtime-inside.cjs']))
   wait_for(state/'app/ingress.sock')
   for attempt in range(100):
    try:
     request=http.client.HTTPConnection('localhost',timeout=2);request.sock=socket.socket(socket.AF_UNIX);request.sock.connect(str(state/'app/ingress.sock'));request.request('GET','/');response=request.getresponse();ok=response.status==200;response.read();request.close()
     if ok:break
    except OSError:pass
    if any(c.poll() is not None for c in children):raise RuntimeError('Application exited')
    time.sleep(.2)
   else:raise RuntimeError('Application readiness timeout')
   transport_health();status('running');last_health=time.monotonic()
   while not stop and auth()==fingerprint:
    if any(c.poll() is not None for c in children):raise RuntimeError('Component exited')
    if time.monotonic()-last_health>=30:transport_health();last_health=time.monotonic()
    time.sleep(2)
  except (OSError,ValueError,KeyError,IndexError,TypeError,RuntimeError,http.client.HTTPException):status('unavailable')
  finally:cleanup()
  if not stop:time.sleep(2)
finally:cleanup();ingress.close();public_socket.unlink(missing_ok=True);status('stopped')
