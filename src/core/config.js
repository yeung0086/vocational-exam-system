'use strict';
/**
 * v3.0 场次配置层：单一事实来源。
 * 优先级：环境变量 > session.json > 内置默认。
 * 新增 v3 字段：sessionId / questionPolicy / security / offline（均可选，缺省走内置默认）。
 */
const { readJSON, shortHash, VERSION } = require('./runtime');

const DEFAULT = {
  schemaVersion: 3,
  title: '培训考试系统', unit: '', school: '', major: '', batch: '', subtitle: '',
  studentPassword: 'CHANGE_ME', adminPassword: 'CHANGE_ME',
  timeLimitSec: 3600, passRate: 60, maxAttempts: 2,
  requireStudentPw: true, exportPrefix: '考试成绩',
  sessionId: '',
  examDate: '', startTime: '', endTime: '',   // 定时门禁：空串=不启用时间窗，沿用手动开关
  questionPolicy: { mode: 'all', sampleSize: null, shuffle: false, seed: '' },
  security: {
    revealMode: 'server',          // server = 逐题服务端判分（默认，题库永不下发答案）
    proctorEnabled: true,          // 切屏只标记待审，绝不自动判罚
    blurThresholdSec: 3,
    blurFlagCount: 3,
    maxLoginPerMinute: 5,
    maxRevealPerSecond: 6
  },
  offline: { serviceWorker: true, outbox: true, replayBatchSize: 20 },
  cloud: { partitionBySession: false }  // 需先在平台执行 schema_v3.sql 才置 true
};

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  Object.keys(patch).forEach(k => {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else if (v !== undefined) out[k] = v;
  });
  return out;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function load() {
  let raw = {};
  try { raw = readJSON('session.json') || {}; }
  catch (e) { raw = {}; }
  const s = merge(DEFAULT, raw);

  // 环境变量覆盖（平台发布 / 临时调试；兼容 v2.2 的所有变量名）
  if (process.env.ADMIN_PASSWORD) s.adminPassword = process.env.ADMIN_PASSWORD;
  else if (process.env.ADMIN_KEY) s.adminPassword = process.env.ADMIN_KEY;
  if (process.env.STUDENT_PASSWORD) s.studentPassword = process.env.STUDENT_PASSWORD;
  s.maxAttempts = envInt('MAX_ATTEMPTS', s.maxAttempts);
  s.timeLimitSec = envInt('TIME_LIMIT_SEC', s.timeLimitSec);
  s.passRate = envInt('PASS_RATE', s.passRate);
  if (process.env.REQUIRE_STUDENT_PW !== undefined) s.requireStudentPw = process.env.REQUIRE_STUDENT_PW !== 'false';
  if (process.env.SESSION_ID) s.sessionId = process.env.SESSION_ID;

  // 规范化，避免脏配置把服务带崩
  s.maxAttempts = Math.max(1, Math.min(20, s.maxAttempts || 2));
  s.timeLimitSec = Math.max(60, s.timeLimitSec || 3600);
  s.passRate = Math.max(0, Math.min(100, Number(s.passRate) || 0));
  if (!s.sessionId) s.sessionId = [s.batch || 'default', s.major || '', s.title || ''].join('-').replace(/\s+/g, '_');
  return s;
}

/** 公开给前端的配置：绝不含口令、盐、密钥。 */
function publicConfig(cfg, bank, roster, extras) {
  return Object.assign({
    title: cfg.title, unit: cfg.unit, school: cfg.school, major: cfg.major,
    batch: cfg.batch, subtitle: cfg.subtitle, exportPrefix: cfg.exportPrefix,
    passRate: cfg.passRate, timeLimit: cfg.timeLimitSec, maxAttempts: cfg.maxAttempts,
    questionCount: bank.count, studentCount: roster.names.length,
    version: VERSION, sessionId: cfg.sessionId, fingerprint: extras.fingerprint,
    themeId: cfg.themeId || 'T2',
    requireStudentPw: cfg.requireStudentPw !== false,
    features: {
      serverSideGrading: true,
      questionSanitized: true,
      serviceWorker: cfg.offline.serviceWorker !== false,
      outbox: cfg.offline.outbox !== false,
      proctor: cfg.security.proctorEnabled !== false,
      shuffle: !!cfg.questionPolicy.shuffle
    }
  }, {});
}

/** 场次指纹：任一配置/名单/题库变化都会变化，用于防串场与健康检查。 */
function fingerprint(cfg, bank, roster) {
  return shortHash(JSON.stringify({
    sessionId: cfg.sessionId, title: cfg.title, passRate: cfg.passRate,
    timeLimitSec: cfg.timeLimitSec, maxAttempts: cfg.maxAttempts,
    shuffle: cfg.questionPolicy.shuffle, bank: bank.fingerprint, roster: roster.fingerprint
  }), 16);
}

module.exports = { DEFAULT, merge, load, publicConfig, fingerprint };
