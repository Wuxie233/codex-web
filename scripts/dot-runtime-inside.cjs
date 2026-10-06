'use strict';
// Private-network service. Only the app ingress socket leaves this namespace.
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),https=require('node:https');
const {spawn,spawnSync}=require('node:child_process');
if(fs.existsSync('/root/.codex')||fs.existsSync('/run/user')||fs.readFileSync('/proc/net/route','utf8').trim().split('\n').length!==1) throw new Error('Runtime isolation failed');
fs.writeFileSync('/state/isolation.json',JSON.stringify({privatePid:true,hostCredentialsVisible:false,hostRoutes:0}));
const cert=spawnSync('/usr/bin/openssl',['req','-config','/dev/null','-x509','-newkey','rsa:2048','-nodes','-keyout','/tmp/relay-key.pem','-out','/tmp/relay-cert.pem','-days','365','-subj','/CN=chatgpt.com','-addext','subjectAltName=IP:127.0.0.1,DNS:chatgpt.com'],{stdio:'ignore'});
if(cert.status!==0)throw new Error('Private TLS initialization failed');
const tls=https.createServer({key:fs.readFileSync('/tmp/relay-key.pem'),cert:fs.readFileSync('/tmp/relay-cert.pem')},(req,res)=>{
 // Central relay enforces endpoint/method/body and idempotency rules.
 const out=http.request({socketPath:'/run/dot/fetch.sock',path:req.url,method:req.method,headers:{...req.headers,host:'chatgpt.com'}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);res.on('close',()=>incoming.destroy())});
 out.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});res.on('close',()=>out.destroy());req.pipe(out);
});
const connections=new Set();
// Raw TLS stays end-to-end; this bridge can reach only the fixed cloud authority.
const cloud=net.createServer(client=>{
 const request=http.request({socketPath:'/run/dot/cloud.sock',method:'CONNECT',path:'codex-cloud-backend.chatgpt.com:443',headers:{host:'codex-cloud-backend.chatgpt.com:443'}});
 connections.add(client);client.on('close',()=>{connections.delete(client);request.destroy()});client.on('error',()=>request.destroy());
 request.setTimeout(20000,()=>request.destroy());request.on('error',()=>client.destroy());
 request.on('connect',(response,upstream,head)=>{
  request.setTimeout(0);
  if(response.statusCode!==200){upstream.destroy();client.destroy();return}
  connections.add(upstream);upstream.on('error',()=>client.destroy());upstream.on('close',()=>{connections.delete(upstream);client.destroy()});client.on('close',()=>upstream.destroy());
  if(head.length)client.write(head);client.pipe(upstream);upstream.pipe(client);
 });request.end();
});
cloud.listen(443,'127.0.0.2');
const ingress=net.createServer(client=>{const upstream=net.connect(8215,'127.0.0.1');for(const s of [client,upstream]){connections.add(s);s.on('close',()=>connections.delete(s));s.on('error',()=>{client.destroy();upstream.destroy()})}client.pipe(upstream);upstream.pipe(client);client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy())});
let app;
function stop(){for(const s of connections)s.destroy();ingress.close();cloud.close();tls.close();app?.kill('SIGTERM');setTimeout(()=>process.exit(0),2000).unref()}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
tls.listen(443,'127.0.0.1',()=>{
 app=spawn('/usr/local/bin/node',['/app/src/server/main.js','--host','127.0.0.1','--port','8215'],{env:{...process.env,SSL_CERT_FILE:'/tmp/relay-cert.pem',NODE_EXTRA_CA_CERTS:'/tmp/relay-cert.pem'},stdio:'ignore'});
 app.once('exit',()=>process.exit(1));
 ingress.listen('/state/ingress.sock',()=>fs.chmodSync('/state/ingress.sock',0o600));
});
