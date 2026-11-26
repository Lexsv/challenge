import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const upstream = new URL(process.env.DAY18_BACKEND_URL || 'http://127.0.0.1:3018');
if (upstream.protocol !== 'http:' || upstream.username || upstream.password)
  throw new Error('Expected an internal HTTP backend URL.');
const root = resolve('/app/dist');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' };
const frontend = createServer(async (req, res) => {
  const host=req.headers.host ?? '';
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { res.writeHead(403).end(); return; }
  if(req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403).end(); return; }
  let url;
  try { url = new URL(req.url ?? '/', `http://${host}`); }
  catch { res.writeHead(400).end(); return; }
  if(url.pathname.startsWith('/api/')) {
    const headers={...req.headers,host:'localhost'};
    if(headers.origin) headers.origin='http://localhost';
    const proxy=request({hostname:upstream.hostname,port:upstream.port || 80,path:url.pathname+url.search,method:req.method,headers}, upstream=>{res.writeHead(upstream.statusCode ?? 502,upstream.headers);upstream.pipe(res);});
    proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);return;
  }
  if(req.method!=='GET' && req.method!=='HEAD') {res.writeHead(405).end();return;}
  let path;
  try { path=resolve(root,`.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  } catch { res.writeHead(400).end(); return; }
  if(path!==root && !path.startsWith(root+sep)) {res.writeHead(403).end();return;}
  try {const data=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)] ?? 'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);} catch {res.writeHead(404).end();}
});
frontend.listen(8080,'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{frontend.close();});
