'use strict';
/**
 * v3.0 题库层：加载/校验、脱敏、种子化乱序、服务端判分。
 * 核心变化：学员端永远拿不到 a（答案）与 e（解析）；
 * 逐题判分与解析改由 POST /api/reveal 在服务端下发，且只能拿已到达题目。
 */
const { readJSON, shortHash } = require('./runtime');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function correctIndexes(q) {
  if (q.type === 'bool') return [q.a ? 0 : 1];
  if (q.type === 'multi') return Array.isArray(q.a) ? q.a.slice() : [];
  return [q.a];
}

function optionsOf(q) { return q.type === 'bool' ? ['对', '错'] : (Array.isArray(q.o) ? q.o : []); }

function isValidPick(q, pick) {
  const n = optionsOf(q).length;
  if (q.type === 'multi') {
    if (!Array.isArray(pick)) return false;
    if (pick.length === 0 || pick.some(i => !Number.isInteger(i) || i < 0 || i >= n)) return false;
    return new Set(pick).size === pick.length;
  }
  return Number.isInteger(pick) && pick >= 0 && pick < n;
}

function grade(q, pick) {
  if (!isValidPick(q, pick)) return false;
  if (q.type === 'multi') {
    const a = correctIndexes(q);
    return pick.length === a.length && a.every(i => pick.includes(i));
  }
  return pick === correctIndexes(q)[0];
}

class Bank {
  constructor(cfg) {
    const raw = readJSON('questions.json');
    if (!Array.isArray(raw) || !raw.length) throw new Error('questions.json 题库加载失败');
    raw.forEach((q, i) => {
      if (!q || typeof q.q !== 'string' || !['bool', 'choice', 'multi'].includes(q.type)) {
        throw new Error('题库第 ' + (i + 1) + ' 题结构非法');
      }
      if (q.type === 'multi' && !Array.isArray(q.a)) throw new Error('题库第 ' + (i + 1) + ' 题多选答案必须是数组');
      if (q.type !== 'bool' && (!Array.isArray(q.o) || q.o.length < 2)) throw new Error('题库第 ' + (i + 1) + ' 题选项缺失');
    });
    this.raw = raw;
    this.fingerprint = shortHash(JSON.stringify(raw), 16);
    this.cfg = cfg;

    const policy = cfg.questionPolicy || {};
    let order = raw.map((_, i) => i);
    if (policy.shuffle) {
      const rnd = mulberry32(seedOf(String(policy.seed || cfg.sessionId || '') + '|' + this.fingerprint));
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    if (policy.mode === 'sample' && Number.isInteger(policy.sampleSize) && policy.sampleSize > 0) {
      order = order.slice(0, Math.min(policy.sampleSize, order.length));
    }
    this.order = order;
    this.count = order.length;

    this.qids = order.map((_, i) => shortHash(this.fingerprint + '|' + cfg.sessionId + '|' + i, 16));
    this.qidIndex = new Map(this.qids.map((q, i) => [q, i]));

    // 学员视图：彻底移除 a / e，展示序号重新编号，只给服务端映射键 qid
    this.publicQuestions = order.map((src, i) => ({
      no: i + 1, qid: this.qids[i], cat: raw[src].cat || '', type: raw[src].type,
      q: raw[src].q, o: optionsOf(raw[src]), diff: raw[src].diff || ''
    }));
    // 管理端视图（需 token）：含答案解析，用于错题分析与成绩导出
    this.fullQuestions = order.map((src, i) => Object.assign({}, raw[src], { no: i + 1, qid: this.qids[i], o: optionsOf(raw[src]) }));
  }
  at(i) { return this.raw[this.order[i]]; }
  indexOf(qid) { const i = this.qidIndex.get(qid); return i === undefined ? -1 : i; }
  sanitized() { return { count: this.count, questions: this.publicQuestions, fingerprint: this.fingerprint }; }
  full() { return { count: this.count, questions: this.fullQuestions, fingerprint: this.fingerprint }; }
  /** 逐题判定：返回可安全下发给单一学员的反馈（含正确答案下标与解析）。 */
  reveal(i, pick) {
    const q = this.at(i);
    const correct = grade(q, pick);
    return { correct, correctIndexes: correctIndexes(q), explanation: q.e || '', type: q.type };
  }
  gradeAll(picks) {
    const answers = [];
    for (let i = 0; i < this.count; i++) answers.push(grade(this.at(i), Array.isArray(picks) ? picks[i] : undefined));
    return answers;
  }
}

module.exports = { Bank, grade, correctIndexes, optionsOf, isValidPick };
