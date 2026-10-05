import socket,threading,select,subprocess,time,os,json,signal
from pathlib import Path
state=Path('/state')
for x in ['home','config','cache','data','profile']:(state/x).mkdir(exist_ok=True)
# Verify the browser sees only this task's filesystem and a loopback-only network.
assert not Path('/root/.codex/auth.json').exists()
assert not Path('/flyshop/dev/deployments/codex-web/source').exists()
assert not Path('/run/docker.sock').exists()
routes=Path('/proc/net/route').read_text()
assert len(routes.splitlines())==1, routes
(state/'isolation.json').write_text(json.dumps({'productionCredentialsVisible':False,'productionSourceVisible':False,'networkRoutes':0,'pid':os.getpid()}))
def pump(a,b):
 try:
  while True:
   readable,_,_=select.select([a,b],[],[],60)
   for s in readable:
    data=s.recv(65536)
    if not data:return
    (b if s is a else a).sendall(data)
 finally:a.close();b.close()
def serve(listener,dial):
 while True:
  a,_=listener.accept()
  def worker(a=a):
   try:b=dial();pump(a,b)
   except Exception:a.close()
  threading.Thread(target=worker,daemon=True).start()
def unix_dial(path):
 s=socket.socket(socket.AF_UNIX);s.connect(path);return s
p=socket.socket();p.bind(('127.0.0.1',18797));p.listen(32)
threading.Thread(target=serve,args=(p,lambda:unix_dial('/state/egress.sock')),daemon=True).start()
c=socket.socket(socket.AF_UNIX);c.bind('/state/cdp.sock');c.listen(8)
threading.Thread(target=serve,args=(c,lambda:socket.create_connection(('127.0.0.1',9222))),daemon=True).start()
children=[]
def start(args,name):
 f=open('/state/'+name+'.log','ab');x=subprocess.Popen(args,stdout=f,stderr=f);children.append(x);return x
try:
 start(['/usr/bin/Xvfb',':99','-screen','0','1280x900x24','-nolisten','tcp'],'display')
 for _ in range(100):
  if Path('/tmp/.X11-unix/X99').exists():break
  time.sleep(.05)
 start(['/browser/chrome','--no-sandbox','--no-first-run','--no-default-browser-check','--disable-dev-shm-usage','--user-data-dir=/tmp/profile','--password-store=basic','--proxy-server=http://127.0.0.1:18797','--proxy-bypass-list=<-loopback>','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222','--window-size=1280,900','about:blank'],'browser')
 while all(x.poll() is None for x in children):time.sleep(1)
 raise RuntimeError('A browser session component exited')
finally:
 for x in children:
  if x.poll() is None:x.terminate()
 for x in children:
  try:x.wait(timeout=3)
  except subprocess.TimeoutExpired:x.kill();x.wait()
