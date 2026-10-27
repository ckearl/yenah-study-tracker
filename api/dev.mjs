// Local dev server: serves ../web and runs the API handler against an in-memory table.
// Usage: node dev.mjs [port]   (password: dev)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import { hashPassword } from './hash-password.mjs';

const vk = webpush.generateVAPIDKeys();
Object.assign(process.env, { TABLE: 'dev', PASSWORD_HASH: hashPassword('dev'), VAPID_SUBJECT: 'mailto:dev@example.com', VAPID_PUBLIC: vk.publicKey, VAPID_PRIVATE: vk.privateKey });
const store = new Map();
const key = (k) => k.pk + '|' + k.sk;
DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const n = cmd.constructor.name, i = cmd.input;
  if (n === 'GetCommand') return { Item: structuredClone(store.get(key(i.Key))) };
  if (n === 'PutCommand') {
    if (i.ConditionExpression && store.has(key(i.Item))) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    store.set(key(i.Item), structuredClone(i.Item)); return {};
  }
  if (n === 'DeleteCommand') { store.delete(key(i.Key)); return {}; }
  if (n === 'QueryCommand') return { Items: [...store.values()].filter((x) => x.pk === i.ExpressionAttributeValues[':p']) };
  if (n === 'UpdateCommand') { // supports the single 'SET attr = :v' form the API uses
    const item = store.get(key(i.Key));
    if (!item) throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
    const [, attr, ph] = /SET (\w+) = (:\w+)/.exec(i.UpdateExpression);
    item[attr] = i.ExpressionAttributeValues[ph]; return {};
  }
  throw new Error('unsupported ' + n);
};
const { handler } = await import('./index.mjs');

const WEB = new URL('../web/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const r = await handler({ rawPath: url.pathname, requestContext: { http: { method: req.method } }, headers: req.headers, body: body || undefined });
    res.writeHead(r.statusCode, r.headers); res.end(r.body); return;
  }
  const p = normalize(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(Number(process.argv[2] ?? 8787), () => console.log('dev server on http://localhost:' + (process.argv[2] ?? 8787)));
