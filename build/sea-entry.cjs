// SEA 单文件入口：静态资源/题库/名单/场次配置从内嵌 assets 读出，原 server.js 无需改动。
// exe 同目录若存在同名文件（外置场次包），优先读外部文件 —— 换场次只需换 Excel，不必重打包。
const sea = require('node:sea');
const fs = require('fs');
const path = require('path');

if (sea.isSea()) {
  const nativeExistsSync = fs.existsSync;   // 拦截前保存原生实现，避免递归
  const EXTERNAL_DIR = path.dirname(process.execPath);
  function isExternal(p) {
    if (!EXTERNAL_DIR || p === null || p === undefined || Buffer.isBuffer(p)) return false;
    const s = String(p).replace(/\\/g, '/').toLowerCase();
    const d = EXTERNAL_DIR.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!s.startsWith(d + '/')) return false;
    try { return nativeExistsSync.call(fs, p); } catch (e) { return false; } // 仅真实存在的外部文件才放行
  }
  const ASSET_KEYS = [
    'students.json', 'questions.json', 'session.json', '.cloud.json',
    'public/admin.css', 'public/admin.html', 'public/index.html',
    'public/qr_admin.png', 'public/qr_student.png', 'public/share.html', 'public/student.css',
    'public/offline.js', 'public/sw.js'
  ];
  function assetKeyFor(p) {
    const s = String(p).replace(/\\/g, '/');
    const i = s.lastIndexOf('/public/');
    if (i >= 0) {
      const k = 'public/' + s.slice(i + '/public/'.length);
      if (ASSET_KEYS.includes(k)) return k;
    }
    for (const k of ['students.json', 'questions.json', 'session.json', '.cloud.json']) {
      if (s === k || s.endsWith('/' + k)) return k;
    }
    return null;
  }
  function assetBuf(k) {
    const a = sea.getAsset(k);
    return Buffer.isBuffer(a) ? a : Buffer.from(a);
  }
  const rawReadSync = fs.readFileSync;
  fs.readFileSync = function (p, opt) {
    if (isExternal(p)) return rawReadSync.apply(this, arguments);
    const k = assetKeyFor(p);
    if (!k) return rawReadSync.apply(this, arguments);
    const buf = assetBuf(k);
    const enc = typeof opt === 'string' ? opt : (opt && opt.encoding);
    return enc ? buf.toString(enc) : buf;
  };
  const rawExists = fs.existsSync;
  fs.existsSync = function (p) {
    if (isExternal(p)) return rawExists.apply(this, arguments);
    return assetKeyFor(p) ? true : rawExists.apply(this, arguments);
  };
  const rawReadAsync = fs.readFile;
  fs.readFile = function (p, opt, cb) {
    if (isExternal(p)) return rawReadAsync.apply(this, arguments);
    const k = assetKeyFor(p);
    const fn = typeof opt === 'function' ? opt : cb;
    if (!k) return rawReadAsync.apply(this, arguments);
    let buf;
    try { buf = assetBuf(k); } catch (e) { return process.nextTick(() => fn(e)); }
    return process.nextTick(() => fn(null, buf));
  };
  // v3.0 的 server.js 用官方 sea.isSea() 判定；此处保留 process.pkg 仅为兼容旧快照代码
  process.pkg = process.pkg || { __sea: true };
}

require('./server.js');
