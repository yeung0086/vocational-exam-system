'use strict';
/**
 * v3.0 安全层：口令派生（scrypt 加盐 + 恒定时间比较）、带 TTL 的令牌池、滑动窗口限流。
 * 修复 v2.2：口令用无盐 sha256 明文比对、管理端 token 永不过期、学员 token 未绑定姓名、登录无限流。
 */
const crypto = require('crypto');

/** 生成一次性口令验证器：盐只存在于内存，每次启动不同。 */
function makeVerifier(password) {
  const salt = crypto.randomBytes(16);
  const expected = crypto.scryptSync(String(password == null ? '' : password), salt, 32);
  return function verify(input) {
    try {
      const got = crypto.scryptSync(String(input == null ? '' : input), salt, 32);
      return crypto.timingSafeEqual(expected, got);
    } catch (_) { return false; }
  };
}

class TokenPool {
  /**
   * @param {number} ttlMs 生存期
   * @param {boolean} sliding 活跃时自动续期（大屏常开不掉线）
   */
  constructor(ttlMs, sliding) {
    this.map = new Map();
    this.ttl = ttlMs;
    this.sliding = !!sliding;
  }
  issue(meta) {
    const t = crypto.randomBytes(24).toString('hex');
    this.map.set(t, Object.assign({ at: Date.now(), exp: Date.now() + this.ttl }, meta || {}));
    return t;
  }
  verify(t) {
    if (!t || typeof t !== 'string') return null;
    const m = this.map.get(t);
    if (!m) return null;
    const now = Date.now();
    if (m.exp < now) { this.map.delete(t); return null; }
    if (this.sliding && m.exp - now < this.ttl / 4) m.exp = now + this.ttl;
    return m;
  }
  /** 把学员 token 与姓名绑定，防止用自己的 token 替他人提交/reveal。 */
  bind(t, name) {
    const m = this.verify(t);
    if (!m) return false;
    if (m.name && m.name !== name) return false;
    m.name = name;
    return true;
  }
  boundTo(t, name) {
    const m = this.verify(t);
    return !!m && (!m.name || m.name === name);
  }
  revoke(t) { return this.map.delete(t); }
  sweep() { const now = Date.now(); for (const [k, v] of this.map) if (v.exp < now) this.map.delete(k); }
  get size() { return this.map.size; }
}

class RateLimiter {
  constructor() { this.map = new Map(); }
  /** @returns {boolean} true = 允许，false = 超限 */
  hit(key, limit, windowMs) {
    const now = Date.now();
    const rec = this.map.get(key);
    if (!rec || now - rec.at > windowMs) { this.map.set(key, { at: now, n: 1 }); return true; }
    if (rec.n >= limit) return false;
    rec.n += 1;
    return true;
  }
  sweep(windowMs) {
    const now = Date.now();
    for (const [k, v] of this.map) if (now - v.at > windowMs) this.map.delete(k);
  }
}

module.exports = { makeVerifier, TokenPool, RateLimiter };
