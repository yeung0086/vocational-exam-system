/**
 * 培训考试系统 · 只读体检（v3.1 阶段六）
 *
 * 用法： node tools/doctor.mjs            控制台输出 + 落盘 tools/doctor_result.json
 *       node tools/doctor.mjs --json     只输出 JSON
 *
 * 原则：只读检查，不修改任何考试数据、不写 data.json / audit.jsonl、不触网。
 * 退出码：存在 ERROR 为 1；仅 WARN/INFO 为 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.resolve(ROOT, '..', '应用程序');
const VALID_THEMES = ['T1', 'T2', 'T3', 'T4', 'T5'];
const VALID_TYPES = ['choice', 'multi', 'bool'];

let errors = 0, warns = 0, infos = 0;
const checks = [];
function add(level, name, detail) {
  checks.push({ level, name, detail: detail || '' });
  if (level === 'ERROR') errors++; else if (level === 'WARN') warns++; else infos++;
}
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = p => fs.existsSync(p);
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 1. Node 版本
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major >= 22) add('INFO', 'Node 版本', process.version + '（≥22）');
else add('ERROR', 'Node 版本', process.version + '，需要 ≥22');

// 2. 必需源码文件
const required = [
  'server.js',
  'src/core/config.js', 'src/core/exam.js', 'src/core/bank.js', 'src/core/roster.js',
  'src/core/runtime.js', 'src/core/security.js',
  'src/http/router.js', 'src/http/routes.js',
  'src/store/local.js', 'src/store/cloud.js', 'src/realtime/sse.js',
  'public/index.html', 'public/admin.html', 'public/share.html',
  'public/student.css', 'public/admin.css', 'public/offline.js', 'public/sw.js'
];
required.forEach(f => add(exists(path.join(ROOT, f)) ? 'INFO' : 'ERROR', '源码文件 ' + f, exists(path.join(ROOT, f)) ? '在位' : '缺失'));

// 3. 三份配置 JSON 口径
let students = null, questions = null, session = null;
try { students = readJSON(path.join(ROOT, 'students.json')); } catch (e) { add('ERROR', 'students.json 解析', e.message); }
try { questions = readJSON(path.join(ROOT, 'questions.json')); } catch (e) { add('ERROR', 'questions.json 解析', e.message); }
try { session = readJSON(path.join(ROOT, 'session.json')); } catch (e) { add('ERROR', 'session.json 解析', e.message); }

if (Array.isArray(students)) {
  const empty = students.filter(n => typeof n !== 'string' || !String(n).trim());
  const dup = students.filter((n, i) => students.indexOf(n) !== i);
  add(!empty.length && !dup.length ? 'INFO' : 'ERROR', '名单口径', students.length + ' 人' + (empty.length ? '，空名 ' + empty.length : '') + (dup.length ? '，重名 ' + dup.length : ''));
}
if (Array.isArray(questions)) {
  const bad = questions.map((q, i) => ({ q, i })).filter(x =>
    !x.q || typeof x.q.q !== 'string' || !VALID_TYPES.includes(x.q.type) ||
    (x.q.type !== 'bool' && (!Array.isArray(x.q.o) || x.q.o.length < 2))
  );
  const types = {};
  questions.forEach(q => { types[q.type] = (types[q.type] || 0) + 1; });
  add(!bad.length ? 'INFO' : 'ERROR', '题库口径', questions.length + ' 题；题型 ' + JSON.stringify(types) + (bad.length ? '，结构非法 ' + bad.length : ''));
  // 口令/密钥字段不得作为题库对象字段名混入（题干正常用词不算泄露）
  const leak = questions.filter(q => Object.keys(q).some(k => /password|resetKey|secret/i.test(k)));
  add(!leak.length ? 'INFO' : 'WARN', '题库无口令字段', leak.length ? '疑似 ' + leak.length + ' 题' : '干净');
}
if (session) {
  const themeOk = VALID_THEMES.includes(session.themeId);
  add(themeOk ? 'INFO' : 'ERROR', '主题编号', session.themeId || '(空)');
  const tl = Number(session.timeLimitSec) || 0;
  add(tl >= 60 ? 'INFO' : 'WARN', '时限下限', tl + ' 秒（下限 60）');
  const pr = Number(session.passRate);
  add(pr >= 0 && pr <= 100 ? 'INFO' : 'ERROR', '及格线', pr + ' 分');
  const ma = Number(session.maxAttempts);
  add(ma >= 1 && ma <= 20 ? 'INFO' : 'ERROR', '答题次数', ma);
  const win = [session.examDate, session.startTime, session.endTime].every(v => v === '' || v == null);
  add('INFO', '定时门禁', win ? '未配置时间窗（沿用手动开关）' : '已配置时间窗 ' + session.examDate + ' ' + session.startTime + '-' + session.endTime);
}

// 4. 工程源码 ↔ 应用程序外置 JSON 哈希一致
if (exists(APP_DIR)) {
  ['session.json', 'students.json', 'questions.json'].forEach(f => {
    const a = path.join(ROOT, f), b = path.join(APP_DIR, f);
    if (!exists(a)) return;
    if (!exists(b)) { add('WARN', '外置 ' + f, '应用程序目录缺失'); return; }
    add(sha256(a) === sha256(b) ? 'INFO' : 'ERROR', '外置 ' + f + ' 一致', sha256(a).slice(0, 12) + ' / ' + sha256(b).slice(0, 12));
  });
} else {
  add('WARN', '应用程序目录', '未找到 ' + APP_DIR + '（源码模式可忽略）');
}

// 5. 云 SDK 依赖
const sdk = path.join(ROOT, 'node_modules', '@tencent-ai', 'workbuddy-cloud-sdk');
add(exists(sdk) ? 'INFO' : 'WARN', '云 SDK 依赖', exists(sdk) ? 'workbuddy-cloud-sdk 在位' : '缺失（离线模式可运行）');

// 6. 自检脚本与结果
add(exists(path.join(ROOT, 'tools', 'selftest_v3.mjs')) ? 'INFO' : 'ERROR', '现行自检脚本', 'selftest_v3.mjs');
try {
  const res = readJSON(path.join(ROOT, 'tools', 'selftest_result.json'));
  add(res.checks && res.checks.fail === 0 ? 'INFO' : 'WARN', '自检结果落盘', 'phase=' + res.phase + ' ' + res.checks.pass + '/' + res.checks.total);
} catch (e) { add('WARN', '自检结果落盘', '读取失败：' + e.message); }

// 7. 回滚基线
const backup = path.resolve(ROOT, '..', '备份', '基线_20261123_v3.0.0');
add(exists(backup) ? 'INFO' : 'WARN', '回滚基线目录', exists(backup) ? '在位' : '缺失');

// 8. 运行时数据（仅存在性，不读取改写）
['data.json', 'audit.jsonl'].forEach(f => {
  add(exists(path.join(ROOT, f)) ? 'INFO' : 'WARN', '运行时 ' + f, exists(path.join(ROOT, f)) ? '在位（体检不改动）' : '无（首考正常）');
});

// 输出
const summary = { timestamp: new Date().toISOString(), node: process.version, root: ROOT, errors, warns, infos, checks };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('==== 培训考试系统 · 只读体检 ====');
  checks.forEach(c => console.log('  [' + c.level + '] ' + c.name + (c.detail ? ' — ' + c.detail : '')));
  console.log('--------------------------------');
  console.log(' 结果：' + errors + ' ERROR / ' + warns + ' WARN / ' + infos + ' INFO');
}
try { fs.writeFileSync(path.join(ROOT, 'tools', 'doctor_result.json'), JSON.stringify(summary, null, 2)); } catch (e) { /* 落盘失败不阻断 */ }
process.exit(errors ? 1 : 0);
