/* 培训考试系统 v3.0 · 离线 outbox
 * 作答/进度/交卷请求在网络异常时排队到 IndexedDB（不可用时降级 localStorage），
 * 恢复网络后按序重放；每条请求自带 eventId，服务端幂等去重，不会重复计数。
 * 不使用 Background Sync（微信内置浏览器与部分国产内核不支持）。
 */
(function (global) {
  'use strict';
  var DB_NAME = 'exam-outbox-v3', STORE = 'events', LS_KEY = 'exam-outbox-v3-fallback';
  var dbp = null, flushing = false;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      if (!global.indexedDB) return resolve(null);
      try {
        var req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (_) { resolve(null); }
    });
    return dbp;
  }
  function lsGet() { try { return JSON.parse(global.localStorage.getItem(LS_KEY) || '[]'); } catch (_) { return []; } }
  function lsSet(a) { try { global.localStorage.setItem(LS_KEY, JSON.stringify(a)); } catch (_) {} }
  function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

  function queue(item) {
    var rec = { id: item.id || uid(), url: item.url, body: item.body || {}, at: Date.now(), tries: 0 };
    return open().then(function (db) {
      if (!db) { var a = lsGet(); a.push(rec); lsSet(a); return rec.id; }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(rec);
          tx.oncomplete = function () { resolve(rec.id); };
          tx.onerror = function () { var a = lsGet(); a.push(rec); lsSet(a); resolve(rec.id); };
        } catch (_) { var b = lsGet(); b.push(rec); lsSet(b); resolve(rec.id); }
      });
    });
  }

  function list(limit) {
    return open().then(function (db) {
      if (!db) return lsGet().sort(function (a, b) { return a.at - b.at; }).slice(0, limit || 20);
      return new Promise(function (resolve) {
        try {
          var out = [], tx = db.transaction(STORE, 'readonly');
          var cur = tx.objectStore(STORE).openCursor();
          cur.onsuccess = function (e) {
            var c = e.target.result;
            if (c && out.length < (limit || 20)) { out.push(c.value); c.continue(); }
            else resolve(out);
          };
          cur.onerror = function () { resolve([]); };
        } catch (_) { resolve([]); }
      });
    });
  }

  function remove(id) {
    return open().then(function (db) {
      if (!db) { lsSet(lsGet().filter(function (x) { return x.id !== id; })); return; }
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = resolve; tx.onerror = resolve;
        } catch (_) { resolve(); }
      });
    });
  }

  function count() { return list(100000).then(function (a) { return a.length; }); }

  /** @param {function} send async (item)=>true 表示服务端已确认 */
  function flush(send, batch) {
    if (flushing) return Promise.resolve({ sent: 0, skipped: true });
    flushing = true;
    return list(batch || 20).then(function (items) {
      var chain = Promise.resolve(0);
      items.forEach(function (it) {
        chain = chain.then(function (n) {
          return Promise.resolve(send(it)).then(function (ok) {
            return ok ? remove(it.id).then(function () { return n + 1; }) : n;
          }).catch(function () { return n; });
        });
      });
      return chain;
    }).then(function (n) { flushing = false; return { sent: n }; })
      .catch(function () { flushing = false; return { sent: 0 }; });
  }

  function autoFlush(send) {
    var tick = function () { if (global.navigator.onLine !== false) flush(send, 20); };
    global.addEventListener('online', tick);
    setInterval(tick, 15000);
    tick();
  }

  global.ExamOffline = { queue: queue, list: list, remove: remove, count: count, flush: flush, autoFlush: autoFlush, uid: uid };
})(window);
