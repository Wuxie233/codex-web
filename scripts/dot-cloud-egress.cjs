#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createEgress}=require('./dot-browser-egress.cjs');
const socket=process.argv[2];
if(!socket || !path.isAbsolute(socket) || fs.existsSync(socket) || (fs.statSync(path.dirname(socket)).mode & 0o777)!==0o700) throw new Error('Private cloud egress socket required');
const egress=createEgress(undefined,new Set(['codex-cloud-backend.chatgpt.com']));
egress.server.listen(socket,()=>fs.chmodSync(socket,0o600));
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await egress.close();try{fs.unlinkSync(socket)}catch(error){if(error.code!=='ENOENT')process.exitCode=1}};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
