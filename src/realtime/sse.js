'use strict';
/** v3.0 实时层：SSE 连接池 + 心跳 + 背压保护 + 版本号（前端可据此判断漏帧）。 */
class Hub {
  constructor(log) {
    this.clients = new Set();
    this.log = log || (() => {});
    this.seq = 0;
    this.timer = null;
  }
  start(intervalMs) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.clients.forEach(res => {
        if (res.writableEnded || res.destroyed) { this.clients.delete(res); return; }
        // 背压：积压超过 1MB 直接断开，让前端重连拿全量快照
        if (res.writableLength > 1024 * 1024) {
          try { res.end(); } catch (_) {}
          this.clients.delete(res);
          return;
        }
        try { res.write(': ping\n\n'); } catch (_) { this.clients.delete(res); }
      });
    }, intervalMs || 20000);
    this.timer.unref && this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  add(req, res, firstPayload) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    if (firstPayload) this._write(res, firstPayload);
    this.clients.add(res);
    const done = () => this.clients.delete(res);
    req.on('close', done);
    res.on('error', done);
  }
  _write(res, payload) {
    try {
      res.write('id: ' + (++this.seq) + '\n');
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    } catch (_) { this.clients.delete(res); }
  }
  broadcast(payload) { this.clients.forEach(res => this._write(res, payload)); }
  get size() { return this.clients.size; }
}

module.exports = { Hub };
