#!/usr/bin/env node
/**
 * ⚠️ 已弃用（v3.0 / 2026-11-09）：本脚本是 v1.0 时代的只读自检，
 *    第 130 行直接请求 GET /api/questions 且不带令牌；v3.0 起该接口要求令牌，
 *    因此本脚本会误报失败。请改用：
 *        node tools/selftest_v3.mjs
 *    本文件仅作为历史留痕保留，不再维护。
 *
 * 家政服务员理论考试系统 · 只读自检（历史）
 *
 * Usage:
 *   node tools/selfcheck.mjs
 *   node tools/selfcheck.mjs http://localhost:3100
 *   node tools/selfcheck.mjs --require-clean
 *   node tools/selfcheck.mjs --json
 *
 * This script performs read-only checks. It never starts, submits, resets,
 * or modifies exam data. Safe to run before an exam or after deployment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const requireClean = argv.includes('--require-clean');
const urlArg = argv.find(a => /^https?:\/\//i.test(a));
const base = (process.env.BASE_URL || urlArg || 'http://localhost:3000').replace(/\/+$/, '');
const adminPassword = process.env.ADMIN_PASSWORD || 'CHANGE_ME';
const studentPassword = process.env.STUDENT_PASSWORD || 'CHANGE_ME';

const checks = [];
const pass = (name, detail = '') => checks.push({ level: 'pass', name, detail });
const warn = (name, detail = '') => checks.push({ level: 'warn', name, detail });
const fail = (name, detail = '') => checks.push({ level: 'fail', name, detail });

function readJSON(rel) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) throw new Error(`missing file: ${rel}`);
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

async function fetchText(route) {
  const res = await fetch(base + route, { redirect: 'follow' });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get('content-type') || '' };
}

async function fetchJSON(route, options) {
  const res = await fetch(base + route, options);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  if (!jsonMode) console.log(`\n家政服务员理论考试系统 · self-check\nTarget: ${base}\n`);

  let cfg = null;
  try {
    cfg = readJSON('system.config.json');
    pass('file:system.config.json', `v${cfg.version || '?'}`);
  } catch (e) {
    fail('file:system.config.json', e.message);
  }

  /* ---------- local files ---------- */
  for (const rel of ['server.js', 'package.json', 'students.json', 'questions.json', 'data.json', 'data.clean.json',
    'public/index.html', 'public/admin.html', 'public/admin.css', 'public/student.css', 'public/share.html']) {
    if (exists(rel)) pass('file', rel); else fail('file', `missing: ${rel}`);
  }

  let localNames = [];
  try {
    const raw = readJSON('students.json');
    if (!Array.isArray(raw) || !raw.length || raw.some(n => typeof n !== 'string' || !n.trim())) {
      throw new Error('students.json must be a non-empty array of names');
    }
    if (new Set(raw).size !== raw.length) throw new Error('duplicate names in students.json');
    localNames = raw;
    const expected = cfg?.roster?.total;
    if (expected && raw.length !== expected) fail('roster:local-total', `${raw.length} names, expected ${expected}`);
    else pass('roster:local-total', `${raw.length} names`);
  } catch (e) {
    fail('roster:local', e.message);
  }

  try {
    const clean = readJSON('data.clean.json');
    const list = Object.values(clean.students || {});
    const allIdle = list.length > 0 && list.every(s => s.status === 'idle');
    if (!allIdle) warn('data:clean', 'data.clean.json is not all idle');
    else if (localNames.length && list.length !== localNames.length) fail('data:clean', `${list.length} students, expected ${localNames.length}`);
    else pass('data:clean', `${list.length} students, all idle`);
  } catch (e) {
    fail('data:clean', e.message);
  }

  try {
    const qs = readJSON('questions.json');
    const expected = cfg?.exam?.questionCount;
    if (expected && qs.length !== expected) fail('questions:local', `${qs.length} questions, expected ${expected}`);
    else if (!Array.isArray(qs) || !qs.length) fail('questions:local', 'empty question bank');
    else pass('questions:local', `${qs.length} questions`);
  } catch (e) {
    fail('questions:local', e.message);
  }

  /* ---------- HTTP API ---------- */
  let names = [];
  try {
    const r = await fetchJSON('/api/names');
    if (r.status !== 200 || !Array.isArray(r.body?.names)) throw new Error(`HTTP ${r.status}`);
    names = r.body.names;
    if (!names.length) throw new Error('empty roster');
    if (new Set(names).size !== names.length) throw new Error('duplicate names');
    if (localNames.length && names.join('\u0000') !== localNames.join('\u0000')) {
      fail('api:names', 'server roster differs from students.json (restart required after editing)');
    } else {
      pass('api:names', `${names.length} names`);
    }
  } catch (e) {
    fail('api:names', `${e.message}. Is the server running at ${base}?`);
  }

  let questions = [];
  try {
    const r = await fetchJSON('/api/questions');
    if (r.status !== 200 || !Array.isArray(r.body?.questions)) throw new Error(`HTTP ${r.status}`);
    questions = r.body.questions;
    const expected = cfg?.exam?.questionCount;
    if (expected && questions.length !== expected) fail('api:questions', `${questions.length}, expected ${expected}`);
    else pass('api:questions', `${questions.length} questions`);

    const bad = [];
    questions.forEach((q, i) => {
      const where = `#${i + 1}`;
      if (!q || typeof q.q !== 'string' || !q.q.trim()) return bad.push(`${where} empty stem`);
      if (!['bool', 'choice', 'multi'].includes(q.type)) return bad.push(`${where} bad type`);
      if (q.type === 'bool') {
        if (typeof q.a !== 'boolean') bad.push(`${where} bool answer must be true/false`);
        return;
      }
      if (!Array.isArray(q.o) || q.o.length < 2) return bad.push(`${where} options missing`);
      if (q.type === 'choice') {
        if (!Number.isInteger(q.a) || q.a < 0 || q.a >= q.o.length) bad.push(`${where} choice answer out of range`);
      } else {
        if (!Array.isArray(q.a) || !q.a.length || new Set(q.a).size !== q.a.length) bad.push(`${where} multi answer invalid`);
        else if (q.a.some(x => !Number.isInteger(x) || x < 0 || x >= q.o.length)) bad.push(`${where} multi answer out of range`);
      }
    });
    if (bad.length) fail('questions:schema', bad.slice(0, 5).join('; '));
    else pass('questions:schema', 'all items valid');
  } catch (e) {
    fail('api:questions', e.message);
  }

  /* ---------- admin ---------- */
  let state = null;
  try {
    const login = await fetchJSON('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminPassword })
    });
    if (login.status !== 200 || !login.body?.token) throw new Error(`HTTP ${login.status}`);
    pass('admin:login', 'ok');

    const r = await fetchJSON('/api/state?token=' + encodeURIComponent(login.body.token));
    if (r.status !== 200 || !r.body?.students) throw new Error(`HTTP ${r.status}`);
    state = r.body;
    if (state.total !== names.length) fail('admin:state', `total ${state.total}, names ${names.length}`);
    else if (state.questionCount !== questions.length) fail('admin:state', `questionCount ${state.questionCount}, bank ${questions.length}`);
    else pass('admin:state', `${state.total} students, ${state.questionCount} questions`);

    const statuses = new Set(state.students.map(s => s.status));
    if ([...statuses].some(x => !['idle', 'doing', 'done'].includes(x))) fail('admin:status', 'unknown student status');
    else pass('admin:status', `${state.students.filter(s => s.status === 'idle').length} idle / ${state.students.filter(s => s.status === 'doing').length} doing / ${state.students.filter(s => s.status === 'done').length} done`);

    const dirty = state.students.filter(s => s.status !== 'idle');
    if (dirty.length) {
      if (requireClean) fail('state:clean', `${dirty.length} student(s) not idle; reset required before a new exam`);
      else warn('state:clean', `${dirty.length} student(s) not idle (do not reset during an exam)`);
    } else {
      pass('state:clean', 'all students idle');
    }

    const backups = cfg?.roster?.backupAccounts || ['备用账号1', '备用账号2'];
    const tail = names.slice(-backups.length);
    if (tail.join('|') !== backups.join('|')) fail('roster:backups', `expected tail ${backups.join(', ')}`);
    else pass('roster:backups', backups.join(', '));
  } catch (e) {
    fail('admin', e.message);
  }

  /* ---------- student gate ---------- */
  try {
    const r = await fetchJSON('/api/student/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: studentPassword })
    });
    if (r.status !== 200 || !r.body?.token) throw new Error(`HTTP ${r.status}`);
    pass('student:login', 'ok');
  } catch (e) {
    fail('student:login', e.message);
  }

  /* ---------- static pages ---------- */
  for (const route of ['/', '/admin', '/share.html']) {
    try {
      const r = await fetchText(route);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      if (!r.text.includes('家政服务员理论考试系统')) throw new Error('title not found');
      pass('page', route);
    } catch (e) {
      fail('page', `${route}: ${e.message}`);
    }
  }

  try {
    const r = await fetchText('/admin');
    const m = r.text.match(/admin\.css\?v=(\d+)/);
    if (m) pass('admin:css', `v${m[1]}`);
    else warn('admin:css', 'version query string not found');
  } catch { /* already reported above */ }

  /* ---------- summary ---------- */
  const nPass = checks.filter(c => c.level === 'pass').length;
  const nWarn = checks.filter(c => c.level === 'warn').length;
  const nFail = checks.filter(c => c.level === 'fail').length;
  const ok = nFail === 0;
  const result = ok ? (nWarn ? 'PASS (with warnings)' : 'PASS') : 'FAIL';

  if (jsonMode) {
    console.log(JSON.stringify({
      ok, result, base,
      checkedAt: new Date().toISOString(),
      summary: { pass: nPass, warn: nWarn, fail: nFail },
      checks
    }, null, 2));
  } else {
    for (const c of checks) {
      const tag = c.level === 'pass' ? '[PASS]' : c.level === 'warn' ? '[WARN]' : '[FAIL]';
      console.log(`${tag} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    }
    console.log(`\nSummary: ${nPass} passed, ${nWarn} warnings, ${nFail} failed`);
    console.log(`Result: ${result}`);
    if (nWarn && !requireClean) console.log('Tip: use --require-clean before a new exam to fail on non-idle students.');
    if (!ok) console.log('Fix the failed checks before running an exam.');
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch(e => {
  if (jsonMode) console.log(JSON.stringify({ ok: false, result: 'FAIL', base, error: String(e) }, null, 2));
  else console.error(`[FAIL] ${e.stack || e}`);
  process.exitCode = 1;
});
