'use strict';
/**
 * v3.0 考试状态机：所有写操作经此层，保证
 *  1) 服务端为唯一判分真值（客户端上报的 answers / score 一律忽略）
 *  2) eventId 幂等（离线 outbox 重放不会重复计数）
 *  3) 每次状态变更生成审计事件、原子落盘、SSE 广播
 *  4) 切屏只标记待审，绝不自动判罚
 */
const { VERSION } = require('./runtime');

const EVENT_TTL = 10 * 60 * 1000;

function freshStudent(name) {
  return {
    name, status: 'idle', progress: 0, total: 0, current: 0,
    score: null, correct: null, durationSec: null, startedAt: null, finishedAt: null,
    answers: [], picks: [], qTimes: [], revealed: [], attempts: 0, integrity: ''
  };
}

class Exam {
  constructor(cfg, bank, roster) {
    this.cfg = cfg;
    this.bank = bank;
    this.roster = roster;
    this.students = {};
    this.updatedAt = Date.now();
    this.studentOpen = true;
    this.proctor = {};
    this.seenEvents = new Map();
    this.hooks = { persist: () => {}, audit: () => {}, broadcast: () => {} };
    this.fresh();
  }
  setHooks(h) { this.hooks = Object.assign(this.hooks, h); }
  fresh() {
    this.students = {};
    this.roster.names.forEach(n => { this.students[n] = freshStudent(n); });
    this.updatedAt = Date.now();
    this.proctor = {};
    this.seenEvents.clear();
  }
  get(name) { return this.students[name] || null; }

  // ---- 服务端计时（v3.1 加固） ----
  /** 是否超过服务端计时上限；以 startedAt 与服务端时钟为准，不采信客户端上报时长。 */
  _timedOut(s) {
    if (!s || !s.startedAt) return false;
    const limit = Number(this.cfg.timeLimitSec) || 0;
    if (!limit) return false;
    return Date.now() - Number(s.startedAt) > limit * 1000;
  }
  /** 服务端口径时长（秒），封顶时限；未开始返回 null。 */
  _serverDuration(s) {
    if (!s || !s.startedAt) return null;
    const limit = Number(this.cfg.timeLimitSec) || Infinity;
    return Math.min(limit, Math.max(0, Math.round((Date.now() - Number(s.startedAt)) / 1000)));
  }
  /** 服务端剩余秒数；未开始返回时限，已结束返回 0。 */
  _remainingSec(s) {
    const limit = Number(this.cfg.timeLimitSec) || 0;
    if (!s || !s.startedAt) return limit;
    return Math.max(0, limit - Math.round((Date.now() - Number(s.startedAt)) / 1000));
  }

  // ---- 定时开收卷门禁（v3.1 加固） ----
  /**
   * 判定当前是否允许学员进入。
   * 规则：手动开关 studentOpen 与场次时间窗取「与」；未配置时间窗时完全沿用手动开关。
   * 返回 {open, reason, window}，reason: manual / open / before / after / closed。
   */
  gateOpen(now) {
    const t = now || new Date();
    const d = String(this.cfg.examDate || '').trim();
    const st = String(this.cfg.startTime || '').trim();
    const et = String(this.cfg.endTime || '').trim();
    const win = { date: d, start: st, end: et };
    if (!d || !st || !et) return { open: this.studentOpen, reason: 'manual', window: win };
    const pad = n => String(n).padStart(2, '0');
    const today = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
    if (today !== d) return { open: false, reason: 'closed', window: win };
    const hm = pad(t.getHours()) + ':' + pad(t.getMinutes());
    if (hm < st) return { open: false, reason: 'before', window: win };
    if (hm > et) return { open: false, reason: 'after', window: win };
    return { open: this.studentOpen, reason: 'open', window: win };
  }

  /** 定时扫描：把超时仍在作答的学员自动收卷（留痕，不判罚）。返回收卷人数。 */
  autoSubmitTimedOut() {
    let n = 0;
    Object.values(this.students).forEach(s => {
      if (s.status === 'doing' && this._timedOut(s)) {
        this._finishTimeout(s);
        n++;
      }
    });
    return n;
  }
  /** 超时自动收卷：按服务端 picks 判分，时长封顶，留痕 timeout-auto-submit。 */
  _finishTimeout(s) {
    const picks = (s.picks || []).filter(x => x !== undefined && x !== null);
    const answers = this.bank.gradeAll(s.picks || []);
    const correct = answers.filter(Boolean).length;
    const total = this.bank.count;
    s.answers = answers; s.picks = s.picks || [];
    s.durationSec = this._serverDuration(s);
    s.status = 'done'; s.attempts = (s.attempts || 0) + 1;
    s.correct = correct; s.score = correct; s.total = total;
    s.finishedAt = Date.now(); s.progress = total; s.current = total;
    s.integrity = picks.length ? 'timeout-auto-submit' : 'timeout-auto-empty';
    this._commit('timeout-auto-submit', s.name, { score: correct, durationSec: s.durationSec });
  }

  /** 从 data.json 恢复（v2.2 与 v3.0 字段双向兼容；监考结构补齐事件与复核字段） */
  restore(saved) {
    if (!saved || !saved.students || typeof saved.students !== 'object') return;
    this.roster.names.forEach(n => {
      const old = saved.students[n];
      if (!old) return;
      const s = freshStudent(n);
      Object.assign(s, old, { name: n });
      ['answers', 'picks', 'qTimes', 'revealed'].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
      this.students[n] = s;
    });
    if (typeof saved.studentOpen === 'boolean') this.studentOpen = saved.studentOpen;
    if (saved.proctor && typeof saved.proctor === 'object') {
      this.proctor = {};
      for (const [name, p] of Object.entries(saved.proctor)) this.proctor[name] = this._normProctor(p);
    }
    this.updatedAt = saved.updatedAt || Date.now();
  }

  /** 监考记录结构归一：兼容旧版 {count, flagged, lastAt}。 */
  _normProctor(p) {
    const old = p || {};
    return {
      count: Number(old.count) || 0,
      flagged: !!old.flagged,
      lastAt: Number(old.lastAt) || 0,
      events: Array.isArray(old.events) ? old.events.slice(-50) : [],
      review: Object.assign({ status: 'pending', note: '', reviewedAt: null, reviewer: '' }, old.review || {})
    };
  }
  serialize() {
    return { version: VERSION, updatedAt: this.updatedAt, studentOpen: this.studentOpen, students: this.students, proctor: this.proctor };
  }

  // ---- 幂等 ----
  _seen(eventId) { return eventId && this.seenEvents.has(String(eventId)); }
  _cached(eventId) { return eventId ? this.seenEvents.get(String(eventId)).result : null; }
  _remember(eventId, result) {
    if (!eventId) return;
    if (this.seenEvents.size > 10000) {
      const cutoff = Date.now() - EVENT_TTL;
      for (const [k, v] of this.seenEvents) if (v.at < cutoff) this.seenEvents.delete(k);
    }
    this.seenEvents.set(String(eventId), { at: Date.now(), result });
  }

  _commit(type, name, extra) {
    this.updatedAt = Date.now();
    this.hooks.audit({ at: this.updatedAt, type, name: name || '', extra: extra || {} });
    this.lastCommit = Promise.resolve(this.hooks.persist(name || null, type));
    this.hooks.broadcast();
    return this.lastCommit;
  }

  // ---- 业务动作 ----
  start(name, total, eventId, studentOpen) {
    if (!this.roster.has(name)) return { ok: false, code: 400, msg: '姓名无效' };
    if (this._seen(eventId)) return Object.assign({ ok: true, duplicate: true }, this._cached(eventId));
    const s = this.students[name];
    if (s.status === 'doing' && this._timedOut(s)) {
      this._finishTimeout(s);
      return { ok: false, code: 403, timeout: true, msg: '考试时间已到，已自动收卷' };
    }
    if (s.status === 'doing') {
      const r = { ok: true, resume: true, attemptNo: s.attempts + 1, max: this.cfg.maxAttempts, current: s.current || 0, total: s.total || this.bank.count, remainingSec: this._remainingSec(s) };
      this._remember(eventId, r);
      return r;
    }
    if (s.status === 'done') return { ok: false, code: 403, msg: '您已完成考试，如需重考请联系管理员授权' };
    if (s.attempts >= this.cfg.maxAttempts) return { ok: false, code: 403, msg: '已达到最大答题次数（' + this.cfg.maxAttempts + ' 次），无法再次开始' };
    if (!studentOpen) return { ok: false, code: 403, closed: true, msg: '学员端暂未开放，请稍候或联系管理员开启' };
    s.status = 'doing'; s.startedAt = Date.now(); s.progress = 0;
    s.total = this.bank.count; s.current = 0;
    s.answers = []; s.picks = []; s.qTimes = []; s.revealed = [];
    s.correct = null; s.score = null; s.durationSec = null; s.finishedAt = null; s.integrity = '';
    delete this.proctor[name];
    const r = { ok: true, attemptNo: s.attempts + 1, max: this.cfg.maxAttempts, total: s.total };
    this._remember(eventId, r);
    this._commit('start', name, { attemptNo: r.attemptNo });
    return r;
  }

  /** 逐题判定：学员只能取已到达题目的反馈，答案永不全量下发。 */
  reveal(name, qid, pick, durationSec, eventId) {
    const s = this.get(name);
    if (!s || s.status !== 'doing') return { ok: false, code: 400, msg: '未开始或已结束' };
    if (this._timedOut(s)) { this._finishTimeout(s); return { ok: false, code: 403, timeout: true, msg: '考试时间已到，已自动收卷' }; }
    const i = this.bank.indexOf(qid);
    if (i < 0) return { ok: false, code: 400, msg: '题目标识无效' };
    const reached = Math.max(s.current || 0, (s.picks || []).length);
    if (i > reached) return { ok: false, code: 403, msg: '题序无效' };
    if (this._seen(eventId)) return Object.assign({ ok: true, duplicate: true }, this._cached(eventId));
    if (s.revealed[i]) {
      const r = this._revealResult(s, i);
      this._remember(eventId, r);
      return r;
    }
    const fb = this.bank.reveal(i, pick);
    s.picks[i] = pick;
    s.qTimes[i] = Number.isFinite(durationSec) ? Math.max(0, Math.round(durationSec)) : 0;
    s.answers[i] = fb.correct;
    s.revealed[i] = { correct: fb.correct, pick: pick, at: Date.now() };
    s.current = Math.max(s.current || 0, i + 1);
    s.progress = s.revealed.filter(Boolean).length;
    const r = this._revealResult(s, i, fb);
    this._remember(eventId, r);
    this._commit('reveal', name, { qid, index: i });
    return r;
  }
  _revealResult(s, i, fb) {
    const cached = s.revealed[i];
    const q = this.bank.at(i);
    return {
      ok: true, index: i,
      correct: cached.correct,
      correctIndexes: fb ? fb.correctIndexes : this._correctOf(q),
      explanation: fb ? fb.explanation : (q.e || ''),
      answered: s.revealed.filter(Boolean).length,
      correctCount: s.answers.filter(x => x === true).length,
      progress: s.progress
    };
  }
  _correctOf(q) {
    if (q.type === 'bool') return [q.a ? 0 : 1];
    if (q.type === 'multi') return Array.isArray(q.a) ? q.a.slice() : [];
    return [q.a];
  }

  /** 进度上报：客户端 answers/score 一律丢弃，由服务端按 picks 重新派生。 */
  progress(name, b) {
    const s = this.get(name);
    if (!s || s.status !== 'doing') return { ok: false, code: 400, msg: '未开始或已结束' };
    if (this._timedOut(s)) { this._finishTimeout(s); return { ok: false, code: 403, timeout: true, msg: '考试时间已到，已自动收卷' }; }
    if (Array.isArray(b.picks)) {
      s.picks = b.picks.slice(0, this.bank.count);
      s.answers = this.bank.gradeAll(s.picks);
    }
    if (Array.isArray(b.qTimes)) s.qTimes = b.qTimes.slice(0, this.bank.count);
    if (Number.isFinite(b.durationSec)) s.durationSec = Math.max(0, Math.round(b.durationSec));
    if (Number.isInteger(b.current)) s.current = Math.max(0, Math.min(this.bank.count, b.current));
    s.total = this.bank.count;
    s.progress = Number.isInteger(b.answered)
      ? Math.max(0, Math.min(this.bank.count, b.answered))
      : s.answers.filter(x => x !== undefined).length;
    this._commit('progress', name, { progress: s.progress, current: s.current });
    return { ok: true, progress: s.progress, correctCount: s.answers.filter(x => x === true).length };
  }

  /** 交卷：以服务端记录的 picks 为准；客户端传入仅作离线缺失时的兜底，并留痕。 */
  submit(name, clientPicks, clientQTimes, durationSec, eventId) {
    const s = this.get(name);
    if (!s) return { ok: false, code: 400, msg: '姓名无效' };
    if (s.status === 'done') {
      return { ok: true, duplicate: true, score: s.score, correct: s.correct, total: s.total, pct: s.total ? Math.round(s.correct / s.total * 100) : 0, passed: s.total ? (s.correct / s.total) >= this.cfg.passRate / 100 : false };
    }
    if (this._seen(eventId)) return Object.assign({ ok: true, duplicate: true }, this._cached(eventId));
    const serverPicks = (s.picks || []).filter(x => x !== undefined && x !== null);
    let picks = serverPicks.length ? s.picks : (Array.isArray(clientPicks) ? clientPicks : []);
    picks = Array.isArray(picks) ? picks.slice(0, this.bank.count) : [];
    if (!serverPicks.length && Array.isArray(clientPicks) && clientPicks.length) s.integrity = 'client-fallback';
    else if (Array.isArray(clientPicks) && JSON.stringify(clientPicks) !== JSON.stringify(picks)) s.integrity = 'client-mismatch';
    const timedOut = this._timedOut(s);
    const answers = this.bank.gradeAll(picks);
    const correct = answers.filter(Boolean).length;
    const total = this.bank.count;
    s.answers = answers; s.picks = picks;
    s.qTimes = Array.isArray(clientQTimes) ? clientQTimes.slice(0, total) : (s.qTimes || []);
    // 时长以服务端时钟为准（封顶时限），仅在无 startedAt 时兜底客户端上报值。
    const serverDur = this._serverDuration(s);
    s.durationSec = serverDur != null ? serverDur : (Number.isFinite(durationSec) ? Math.max(0, Math.round(durationSec)) : (s.durationSec || 0));
    s.status = 'done'; s.attempts = (s.attempts || 0) + 1;
    s.correct = correct; s.score = correct; s.total = total;
    s.finishedAt = Date.now(); s.progress = total; s.current = total;
    if (timedOut && s.integrity === '') s.integrity = 'timeout-submit';
    const r = {
      ok: true, score: correct, correct, total, timedOut, durationSec: s.durationSec,
      pct: total ? Math.round(correct / total * 100) : 0,
      passed: total ? (correct / total) >= this.cfg.passRate / 100 : false,
      integrity: s.integrity || 'server-authoritative'
    };
    this._remember(eventId, r);
    this._commit('submit', name, { score: correct, integrity: s.integrity, timedOut });
    return r;
  }

  resetAll() { this.fresh(); return this._commit('reset-all', null, {}); }
  resetStudent(name) {
    if (!this.roster.has(name)) return null;
    this.students[name] = freshStudent(name);
    delete this.proctor[name];
    return this._commit('reset-student', name, {});
  }
  clearDoing() {
    let n = 0;
    Object.values(this.students).forEach(s => {
      if (s.status === 'doing') { Object.assign(s, freshStudent(s.name)); n++; }
    });
    this._commit('clear-doing', null, { cleared: n });
    return n;
  }
  setOpen(open) {
    this.studentOpen = open !== false;
    return this._commit('set-open', null, { open: this.studentOpen });
  }

  static PROCTOR_EVENTS = ['blur', 'copy', 'cut', 'contextmenu', 'tab-switch', 'idle', 'other'];

  /**
   * 监考事件上报：仅累计、记录事件、标记待审；不改动成绩、不强制交卷。
   * event: blur(切屏/失焦) | copy | cut | contextmenu | tab-switch | idle | other
   */
  flagProctor(name, opts) {
    if (this.cfg.security.proctorEnabled === false) return { ok: true, disabled: true };
    const cfg = this.cfg.security;
    const o = opts || {};
    const event = Exam.PROCTOR_EVENTS.includes(o.event) ? o.event : 'other';
    const durationSec = Number(o.durationSec);
    if (event === 'blur') {
      if (!Number.isFinite(durationSec) || durationSec < (cfg.blurThresholdSec || 3)) return { ok: true, ignored: true };
    }
    const p = this._normProctor(this.proctor[name]);
    this.proctor[name] = p;
    p.count += 1; p.lastAt = Date.now();
    p.events.push({ at: Date.now(), type: event, detail: String(o.detail || '').slice(0, 120), durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : 0 });
    if (p.events.length > 50) p.events = p.events.slice(-50);
    if (p.count >= (cfg.blurFlagCount || 3)) p.flagged = true;
    this.hooks.audit({ at: Date.now(), type: 'proctor-' + event, name, extra: { event, durationSec, count: p.count, flagged: p.flagged } });
    this.hooks.persist(null, 'proctor');
    this.hooks.broadcast();
    return { ok: true, count: p.count, flagged: p.flagged };
  }

  /** 人工复核闭环：confirmed / dismissed / pending；只改复核结论，绝不自动改分。 */
  reviewProctor(name, action, note, reviewer) {
    if (!this.roster.has(name)) return { ok: false, code: 400, msg: '姓名无效' };
    const p = this._normProctor(this.proctor[name]);
    this.proctor[name] = p;
    const valid = ['confirmed', 'dismissed', 'pending'].includes(action) ? action : null;
    if (!valid) return { ok: false, code: 400, msg: '复核结论无效（confirmed/dismissed/pending）' };
    p.review = { status: valid, note: String(note || '').slice(0, 200), reviewedAt: Date.now(), reviewer: String(reviewer || '').slice(0, 40) };
    if (valid === 'dismissed') p.flagged = false;   // 解除待审；confirmed 保留标记供留痕
    this.hooks.audit({ at: Date.now(), type: 'proctor-review', name, extra: { action: valid, reviewer: p.review.reviewer } });
    this.hooks.persist(name, 'proctor');
    this.hooks.broadcast();
    return { ok: true, review: p.review, flagged: p.flagged };
  }

  /** 大屏快照：字段兼容 v2.2，新增版本/指纹/待审标记。 */
  snapshot(extra) {
    const list = Object.values(this.students);
    const started = list.filter(s => s.status !== 'idle').length;
    const done = list.filter(s => s.status === 'done');
    let sumScore = 0, sumTotal = 0;
    done.forEach(s => { sumScore += s.correct || 0; sumTotal += s.total || 0; });
    const avgPct = sumTotal ? Math.round(sumScore / sumTotal * 100) : 0;
    const pass = done.filter(s => s.total && (s.correct / s.total) >= this.cfg.passRate / 100).length;
    const perQ = {};
    done.forEach(s => {
      if (Array.isArray(s.answers)) s.answers.forEach((ok, i) => {
        perQ[i] = perQ[i] || { c: 0, t: 0, timeSum: 0, timeN: 0 };
        perQ[i].t++; if (ok) perQ[i].c++;
        if (Array.isArray(s.qTimes) && typeof s.qTimes[i] === 'number') { perQ[i].timeSum += s.qTimes[i]; perQ[i].timeN++; }
      });
    });
    Object.keys(perQ).forEach(k => { const o = perQ[k]; o.avgTime = o.timeN ? Math.round(o.timeSum / o.timeN) : 0; delete o.timeSum; delete o.timeN; });
    const students = list.map(s => {
      const wrongs = (Array.isArray(s.answers) ? s.answers : []).map((ok, i) => ok ? -1 : i).filter(i => i >= 0);
      const p = this.proctor[s.name];
      const proctor = p ? {
        count: p.count, flagged: p.flagged, review: p.review,
        events: (p.events || []).slice(-5)
      } : null;
      return Object.assign({}, s, { wrongs, flagged: !!(p && p.flagged), proctor, revealCount: (s.revealed || []).filter(Boolean).length });
    });
    const gate = this.gateOpen();
    const pendingReview = list.filter(s => {
      const p = this.proctor[s.name];
      return p && p.flagged && p.review.status !== 'dismissed';
    }).map(s => s.name);
    return Object.assign({
      updatedAt: this.updatedAt, serverTime: Date.now(),
      total: list.length, started, done: done.length, finCount: done.length,
      avgPct, passCount: pass, perQuestion: perQ, students,
      questionCount: this.bank.count, maxAttempts: this.cfg.maxAttempts,
      timeLimit: this.cfg.timeLimitSec, passRate: this.cfg.passRate,
      studentOpen: this.studentOpen, gate,
      version: VERSION, sessionId: this.cfg.sessionId, fingerprint: this.fingerprint || '',
      proctorFlagged: pendingReview
    }, extra || {});
  }
}

module.exports = { Exam, freshStudent };
