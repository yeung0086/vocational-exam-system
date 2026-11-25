'use strict';
/** v3.0 HTTP 层：路由表 + 统一安全头 + body 限额/超时 + 集中错误处理。 */
const BODY_LIMIT = 1 * 1024 * 1024;

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

function sendJSON(res, obj, code) {
  if (res.headersSent) return;
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { if (!done) { finish(reject, new Error('body timeout')); try { req.destroy(); } catch (_) {} } }, 10000);
    req.on('data', c => {
      d += c;
      if (d.length > BODY_LIMIT) { finish(reject, new Error('body too large')); try { req.destroy(); } catch (_) {} }
    });
    req.on('end', () => finish(v => {
      try { resolve(v ? JSON.parse(v) : {}); } catch (e) { reject(e); }
    }, d));
    req.on('error', e => finish(reject, e));
  });
}

function createApp(log) {
  const routes = [];
  let fallback = ctx => sendJSON(ctx.res, { ok: false, msg: 'not found' }, 404);

  const app = {
    add(method, pathname, handler, opts) { routes.push({ method, pathname, handler, opts: opts || {} }); return app; },
    setFallback(fn) { fallback = fn; return app; },
    async handle(req, res) {
      setSecurityHeaders(res);
      let u;
      try { u = new URL(req.url, 'http://localhost'); }
      catch (_) { return sendJSON(res, { ok: false, msg: 'bad url' }, 400); }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const route = routes.find(r => r.pathname === u.pathname && r.method === req.method);
      const ctx = {
        req, res, u, ip: clientIp(req), ua: String(req.headers['user-agent'] || ''),
        body: {}, route: route || null,
        send: (o, c) => sendJSON(res, o, c),
        fail: (msg, c) => sendJSON(res, { ok: false, msg: msg || 'error' }, c || 400),
        query: u.searchParams
      };
      try {
        if (!route) return await fallback(ctx);
        if (req.method === 'POST' || req.method === 'PUT') {
          try { ctx.body = await readBody(req); }
          catch (e) { return ctx.fail('请求体无效或过大', 400); }
        }
        await route.handler(ctx);
      } catch (e) {
        (log || console.error)('[http] ' + req.method + ' ' + u.pathname + ' -> ' + (e && e.stack ? e.stack : e));
        if (!res.headersSent) sendJSON(res, { ok: false, msg: '服务内部错误' }, 500);
        else if (!res.writableEnded) res.end();
      }
    }
  };
  return app;
}

module.exports = { createApp, sendJSON, setSecurityHeaders, readBody, clientIp };
