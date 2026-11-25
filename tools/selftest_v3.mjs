/**
 * 培训考试系统 v3.0 · 端到端自检
 * 覆盖：题库脱敏、鉴权、服务端权威判分、幂等重放、令牌绑定、开关、离线资源、原子写与重启恢复。
 * 用法： node tools/selftest_v3.mjs      （自动起停一个 3399 端口的独立实例，不碰线上数据）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), 'exam-v3-selftest');
const PORT = 3399;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0, serverLog = '', child = null;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(p, opts) {
  const o = opts || {};
  const r = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}),
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d, headers: r.headers };
}
const post = (p, body) => req(p, { method: 'POST', body: body || {} });

function boot() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: TMP, CLOUD_DISABLE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', b => { serverLog += b.toString(); });
  child.stderr.on('data', b => { serverLog += b.toString(); });
}
async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    try { const r = await req('/api/health'); if (r.status === 200 && r.d && r.d.ok) return r.d; } catch (_) {}
    await sleep(200);
  }
  throw new Error('服务未在限定时间内就绪\n' + serverLog.slice(-1500));
}
async function shutdown() {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 4000);
  });
}
function correctPick(q) {
  if (q.type === 'bool') return q.a ? 0 : 1;
  if (q.type === 'multi') return Array.isArray(q.a) ? q.a.slice() : [];
  return q.a;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  boot();
  try {
    const h = await waitHealth();
    console.log('\n=== A. 运行时与版本 ===');
    check('health 返回 v3.1.0', h.version === '3.1.0', h.version);
    check(`题库 ${h.questionCount} 题 / 名单 ${h.studentCount} 人`, h.questionCount === 100 && h.studentCount >= 30, h.questionCount + '/' + h.studentCount);
    check('自检实例不连云端', h.cloud.available === false, JSON.stringify(h.cloud));
    check('安全头 X-Content-Type-Options', (await req('/api/health')).headers.get('x-content-type-options') === 'nosniff');

    console.log('\n=== B. P0 安全：题库脱敏与鉴权 ===');
    let r = await req('/api/questions');
    check('无 token 取题库 -> 401', r.status === 401, String(r.status));
    r = await post('/api/student/login', { password: 'wrong-pw' });
    check('错误学员口令 -> 401', r.status === 401, String(r.status));
    r = await post('/api/student/login', { password: process.env.STUDENT_PASSWORD || 'CHANGE_ME' });
    const stuToken = r.d && r.d.token;
    check('正确学员口令 -> 拿到 token', r.status === 200 && !!stuToken);
    r = await req('/api/questions?token=' + encodeURIComponent(stuToken));
    const qs = (r.d && r.d.questions) || [];
    const leaked = qs.filter(q => Object.prototype.hasOwnProperty.call(q, 'a') || Object.prototype.hasOwnProperty.call(q, 'e'));
    check('学员题库 100 题且零答案/解析泄露', r.status === 200 && qs.length === 100 && leaked.length === 0, '泄露 ' + leaked.length + ' 题');
    check('题目带服务端 qid 映射键', qs.every(q => typeof q.qid === 'string' && q.qid.length >= 12));
    r = await post('/api/admin/login', { password: 'bad' });
    check('错误管理口令 -> 401', r.status === 401);
    r = await post('/api/admin/login', { password: process.env.ADMIN_PASSWORD || 'CHANGE_ME' });
    const adminToken = r.d && r.d.token;
    check('正确管理口令 -> 拿到 token', !!adminToken);
    r = await req('/api/admin/questions?token=' + encodeURIComponent(adminToken));
    const full = (r.d && r.d.questions) || [];
    check('管理端题库含答案解析', full.length === 100 && Object.prototype.hasOwnProperty.call(full[0], 'a'), String(full.length));
    check('无 token 取大屏快照 -> 401', (await req('/api/state')).status === 401);
    check('reset 的 key= 旁路已移除', (await post('/api/reset?key=' + (process.env.ADMIN_PASSWORD || 'CHANGE_ME'), {})).status === 401);

    console.log('\n=== C. 服务端权威判分与幂等 ===');
    const names = (await req('/api/names')).d.names;
    const me = names[0], other = names[1];
    const fullMap = new Map(full.map(q => [q.qid, q]));
    const q0 = qs[0];
    const pick0 = correctPick(fullMap.get(q0.qid));
    r = await post('/api/start', { name: me, total: 100, token: stuToken, eventId: 'ev-start-1' });
    check('开考成功', r.d && r.d.ok === true, JSON.stringify(r.d));
    r = await post('/api/reveal', { name: me, qid: q0.qid, pick: pick0, durationSec: 5, token: stuToken, eventId: 'ev-reveal-1' });
    check('逐题判分返回正确反馈', r.d && r.d.ok === true && r.d.correct === true && Array.isArray(r.d.correctIndexes), JSON.stringify(r.d));
    check('reveal 下发解析文本', !!(r.d && typeof r.d.explanation === 'string'));
    r = await post('/api/reveal', { name: me, qid: q0.qid, pick: pick0, durationSec: 5, token: stuToken, eventId: 'ev-reveal-1' });
    check('同 eventId 重放不重复计数', r.d && r.d.duplicate === true && r.d.answered === 1, JSON.stringify(r.d));
    r = await post('/api/reveal', { name: other, qid: q0.qid, pick: pick0, durationSec: 5, token: stuToken, eventId: 'ev-reveal-x' });
    check('令牌绑姓名，跨学员冒用 -> 403', r.status === 403, String(r.status));
    r = await post('/api/reveal', { name: me, qid: qs[50].qid, pick: 0, durationSec: 1, token: stuToken, eventId: 'ev-reveal-skip' });
    check('跳题索取答案 -> 403', r.status === 403, String(r.status));

    const allCorrect = qs.map(q => correctPick(fullMap.get(q.qid)));
    r = await post('/api/submit', { name: me, picks: allCorrect, qTimes: [], durationSec: 60, token: stuToken, eventId: 'ev-submit-1' });
    check('篡改 picks 无法伪造满分', r.d && r.d.ok === true && r.d.score === 1, '服务端分数=' + (r.d && r.d.score));
    check('返回服务端判分而非客户端分数', r.d && r.d.integrity === 'client-mismatch', r.d && r.d.integrity);
    r = await post('/api/submit', { name: me, picks: allCorrect, durationSec: 60, token: stuToken, eventId: 'ev-submit-1' });
    check('交卷重放幂等，分数不变', r.d && r.d.ok === true && r.d.score === 1 && r.d.duplicate === true, JSON.stringify(r.d));
    const state = (await req('/api/state?token=' + encodeURIComponent(adminToken))).d;
    const mine = state.students.find(s => s.name === me);
    check('大屏快照 attempts 只 +1', mine.attempts === 1, String(mine.attempts));
    check('快照带版本与指纹', state.version === '3.1.0' && typeof state.fingerprint === 'string');

    console.log('\n=== D. 学员端开关与离线资源 ===');
    r = await post('/api/admin/set-student-open?token=' + encodeURIComponent(adminToken), { open: false });
    check('关闭学员端', r.d && r.d.open === false);
    check('关闭后学员登录 -> 403', (await post('/api/student/login', { password: process.env.STUDENT_PASSWORD || 'CHANGE_ME' })).status === 403);
    r = await post('/api/admin/toggle-student?token=' + encodeURIComponent(adminToken), {});
    check('一键切换重新开放', r.d && r.d.open === true);
    check('重新开放后学员登录 -> 200', (await post('/api/student/login', { password: process.env.STUDENT_PASSWORD || 'CHANGE_ME' })).status === 200);
    check('sw.js 可访问', (await req('/sw.js')).status === 200);
    check('offline.js 可访问', (await req('/offline.js')).status === 200);
    check('目录穿越被拦截', (await req('/../server.js')).status !== 200);
    check('切屏标记接口可用且只标记', (await post('/api/proctor', { name: me, token: stuToken, durationSec: 4 })).d.flagged === false);
    const cfgPub = (await req('/api/config')).d;
    check('公开配置带主题编号 themeId', !!cfgPub && ['T1','T2','T3','T4','T5'].includes(cfgPub.themeId), String(cfgPub && cfgPub.themeId));

    console.log('\n=== D2. 监考事件扩展与人工复核闭环（v3.1）===');
    r = await post('/api/proctor', { name: me, event: 'copy', detail: '复制作答区', token: stuToken, eventId: 'ev-proctor-copy' });
    check('复制事件可上报并记录', r.d && r.d.ok === true, JSON.stringify(r.d));
    r = await post('/api/proctor', { name: me, event: 'contextmenu', token: stuToken, eventId: 'ev-proctor-ctx' });
    check('右键事件可上报并记录', r.d && r.d.ok === true);
    for (let i = 0; i < 4; i++) { await post('/api/proctor', { name: me, event: 'blur', durationSec: 5, token: stuToken, eventId: 'ev-blur-' + i }); }
    r = await post('/api/admin/proctor-review?token=' + encodeURIComponent(adminToken), { name: me, action: 'confirmed', note: '人工确认异常' });
    check('管理端复核确认', r.d && r.d.ok === true && r.d.review.status === 'confirmed', JSON.stringify(r.d));
    let st2 = (await req('/api/state?token=' + encodeURIComponent(adminToken))).d;
    let mine2 = st2.students.find(s => s.name === me);
    check('快照带出复核结论与事件摘要', mine2.proctor && mine2.proctor.review.status === 'confirmed' && Array.isArray(mine2.proctor.events));
    r = await post('/api/admin/proctor-review?token=' + encodeURIComponent(adminToken), { name: me, action: 'dismissed' });
    check('解除待审后 flagged 复位', r.d && r.d.ok === true && r.d.flagged === false);
    st2 = (await req('/api/state?token=' + encodeURIComponent(adminToken))).d;
    check('解除后待审名单不含该生', !st2.proctorFlagged.includes(me));
    check('快照带门禁字段 gate（未配时间窗=manual）', !!st2.gate && st2.gate.reason === 'manual', JSON.stringify(st2.gate));

    console.log('\n=== E. 原子落盘与重启恢复 ===');
    check('data.json 已生成', fs.existsSync(path.join(TMP, 'data.json')));
    check('audit.jsonl 审计已生成', fs.existsSync(path.join(TMP, 'audit.jsonl')));
    const audit = fs.readFileSync(path.join(TMP, 'audit.jsonl'), 'utf8');
    check('审计不含答案字段', !/"(a|e|explanation|password)"\s*:/.test(audit));
    await shutdown();
    boot();
    const h2 = await waitHealth();
    check('重启后 health 正常', h2.version === '3.1.0');
    const st = await req('/api/student-status?name=' + encodeURIComponent(me));
    check('重启后成绩状态从磁盘恢复', st.d && st.d.status === 'done' && st.d.attempts === 1, JSON.stringify(st.d));
  } finally {
    await shutdown();
  }
  console.log('\n' + '='.repeat(56));
  console.log(' 自检结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('='.repeat(56));
  if (fail) console.log('\n服务日志尾部:\n' + serverLog.slice(-2000));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('\n[FATAL] ' + (e && e.stack ? e.stack : e)); console.error(serverLog.slice(-2000)); if (child) child.kill('SIGTERM'); process.exit(1); });
