'use strict';
/**
 * v3.0 云端适配层：把 SDK 调用全部收敛到此处，便于日后更换 SDK 版本 / 后端。
 * 保持 v2.2 云端表结构（exam_results / exam_config）与字段不变，无需执行任何 DDL 即可升级。
 * 新增：失败重试、串行写、健康检查计数、显式降级标记（不再静默失败）。
 */
const fs = require('fs');
const { cfgPath } = require('../core/runtime');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CloudAdapter {
  constructor(log) {
    this.log = log || (() => {});
    this.client = null;
    this.endpoint = '';
    this.available = false;
    this.stats = { reads: 0, writes: 0, failures: 0, lastError: '', lastSuccessAt: 0 };
    this.openCache = { at: 0, val: true };
    this.cfgSeq = 0;
    this.cfgChain = Promise.resolve();
    try {
      const sdk = require('@tencent-ai/workbuddy-cloud-sdk');
      const create = sdk.createWorkBuddyCloud || (sdk.default && sdk.default.createWorkBuddyCloud);
      let cc = null;
      if (process.env.CLOUD_ENDPOINT && process.env.CLOUD_PUBLISHABLE_KEY) {
        cc = { endpoint: process.env.CLOUD_ENDPOINT, publishableKey: process.env.CLOUD_PUBLISHABLE_KEY };
      } else if (process.env.CLOUD_DISABLE === '1') {
        cc = null;
      } else {
        const p = cfgPath('.cloud.json');
        if (fs.existsSync(p)) { try { cc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { cc = null; } }
      }
      if (create && cc && cc.endpoint && cc.publishableKey) {
        this.client = create({ endpoint: cc.endpoint, publishableKey: cc.publishableKey });
        this.endpoint = cc.endpoint;
        this.available = true;
        this.log('[cloud] 已连接云服务: ' + cc.endpoint + '（v3 适配层）');
      } else {
        this.log('[cloud] 未配置云端，使用本地 data.json（离线模式）');
      }
    } catch (e) {
      this.client = null;
      this.log('[cloud] SDK 不可用，降级本地: ' + (e && e.message));
    }
  }

  async _retry(fn, label) {
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fn();
        this.stats.reads += 1;
        this.stats.lastSuccessAt = Date.now();
        this.stats.lastError = '';
        return r;
      } catch (e) {
        lastErr = e;
        this.stats.failures += 1;
        this.stats.lastError = label + ': ' + (e && e.message ? e.message : String(e));
        if (i < 2) await sleep(120 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 启动恢复：云端为共享真值，本地 data.json 仅作备份。 */
  async loadAll(roster, exam) {
    if (!this.available) return false;
    try {
      const { data: cfg } = await this._retry(() => this.client.database.from('exam_config').select('*'), 'read-config');
      if (Array.isArray(cfg)) {
        cfg.forEach(r => { if (r.key === 'studentOpen') exam.studentOpen = r.value_json !== false; });
        this.openCache = { at: Date.now(), val: exam.studentOpen };
      }
      const { data: rows } = await this._retry(() => this.client.database.from('exam_results').select('*'), 'read-results');
      if (Array.isArray(rows)) rows.forEach(r => {
        if (!roster.has(r.name)) return;
        const s = exam.get(r.name);
        if (!s) return;
        s.status = r.status || 'idle'; s.progress = r.progress || 0; s.total = r.total || 0; s.current = r.current || 0;
        s.score = r.score; s.correct = r.correct; s.durationSec = r.duration_sec;
        s.attempts = r.attempts || 0; s.startedAt = r.started_at; s.finishedAt = r.finished_at;
        s.answers = Array.isArray(r.answers) ? r.answers : [];
        s.picks = Array.isArray(r.picks) ? r.picks : [];
        s.qTimes = Array.isArray(r.q_times) ? r.q_times : [];
      });
      this.log('[cloud] 已从云端恢复考试状态（' + (Array.isArray(rows) ? rows.length : 0) + ' 行）');
      return true;
    } catch (e) {
      this.log('[cloud] 启动恢复失败，沿用本地备份: ' + this.stats.lastError);
      return false;
    }
  }

  /** 单学员落云：显式剔除 revealed / integrity 等 v3 本地字段，保证旧表结构兼容。 */
  async saveStudent(s) {
    if (!this.available || !s) return false;
    const row = {
      name: s.name, status: s.status, progress: s.progress, total: s.total, current: s.current,
      score: s.score, correct: s.correct, duration_sec: s.durationSec, attempts: s.attempts || 0,
      answers: s.answers || [], picks: s.picks || [], q_times: s.qTimes || [],
      started_at: s.startedAt, finished_at: s.finishedAt
    };
    try {
      await this._retry(() => this.client.database.from('exam_results').upsert(row), 'write-result');
      this.stats.writes += 1;
      return true;
    } catch (_) { return false; }
  }

  /** 配置串行写：快速连切时只落最后一次，避免中间态覆盖。 */
  saveConfig(open) {
    if (!this.available) { this.openCache = { at: Date.now(), val: open }; return Promise.resolve(); }
    const my = ++this.cfgSeq;
    this.openCache = { at: Date.now(), val: open };
    this.cfgChain = this.cfgChain.catch(() => {}).then(async () => {
      if (my !== this.cfgSeq) return;
      try {
        await this._retry(() => this.client.database.from('exam_config').upsert({ key: 'studentOpen', value_json: open }), 'write-config');
        this.stats.writes += 1;
      } catch (_) { /* 本地已是真值备份 */ }
    });
    return this.cfgChain;
  }

  /** 跨实例开关：3 秒 TTL 实时读云端；云不可用则回退本地内存。 */
  async readOpen(fallback, exam) {
    if (!this.available) return fallback;
    if (Date.now() - this.openCache.at < 3000) return this.openCache.val;
    try {
      const { data: cfg } = await this._retry(() => this.client.database.from('exam_config').select('*'), 'read-open');
      const row = Array.isArray(cfg) ? cfg.find(r => r.key === 'studentOpen') : null;
      const val = row ? row.value_json !== false : fallback;
      exam.studentOpen = val;
      this.openCache = { at: Date.now(), val };
      return val;
    } catch (_) {
      this.openCache = { at: Date.now(), val: fallback };  // 失败也短暂缓存，避免每请求卡网络
      return fallback;
    }
  }

  health() {
    return {
      available: this.available, endpoint: this.endpoint,
      reads: this.stats.reads, writes: this.stats.writes,
      failures: this.stats.failures, lastError: this.stats.lastError,
      lastSuccessAt: this.stats.lastSuccessAt
    };
  }
}

module.exports = { CloudAdapter };
