'use strict';
/**
 * v3.0 API 路由表：全部路径与 v2.2 保持兼容，另加 health / reveal / proctor / admin.questions。
 * 安全模型：题库必须带令牌；学员令牌只能取脱敏题；判分与解析只在服务端；
 *          管理接口一律要求管理令牌（移除 v2.2 的 key= 旁路）。
 */
const fs = require('fs');
const path = require('path');
const { VERSION, BUILD_TAG, isSea, isPackaged, PUBLIC_DIR, MIME } = require('../core/runtime');

function register(app, d) {
  const { cfg, bank, roster, exam, cloud, hub, adminTokens, stuTokens,
          verifyAdmin, verifyStudent, limiter, publicConfig, fingerprint } = d;
  exam.fingerprint = fingerprint;   // 所有 SSE 快照 / state 均带场次指纹

  function tok(ctx) {
    // 注意：云平台网关注入平台级 Authorization（非本系统令牌），必须先排除，
    // 否则会把 379 位的平台令牌误当成考试令牌，导致所有带令牌 API 401。
    const x = ctx.req.headers['x-exam-token'];
    if (typeof x === 'string' && x) return x.trim();
    const st = ctx.query.get('stoken');
    if (st) return st;
    const bt = ctx.body && ctx.body.token;
    if (bt) return bt;
    const qt = ctx.query.get('token');
    if (qt) return qt;
    const h = ctx.req.headers.authorization;
    if (typeof h === 'string' && /^Bearer\s+/i.test(h)) {
      const v = h.replace(/^Bearer\s+/i, '').trim();
      // 平台注入的令牌很长，本系统令牌为 48 位十六进制
      if (/^[0-9a-f]{48}$/i.test(v)) return v;
    }
    return '';
  }
  const needAdmin = ctx => adminTokens.verify(tok(ctx));
  const needStudent = (ctx, name) => {
    const t = tok(ctx);
    const m = stuTokens.verify(t);
    if (!m) return false;
    return name ? stuTokens.boundTo(t, name) : true;
  };

  // ---------- 公开元信息 ----------
  app.add('GET', '/api/health', ctx => ctx.send({
    ok: true, version: VERSION, build: BUILD_TAG,
    node: process.version, platform: process.platform,
    packaged: isPackaged, sea: isSea,
    sessionId: cfg.sessionId, fingerprint,
    questionCount: bank.count, studentCount: roster.names.length,
    cloud: cloud.health(), sseClients: hub.size,
    uptimeSec: Math.round(process.uptime()), serverTime: Date.now(),
    features: {
      serverSideGrading: true, sanitizedQuestions: true,
      eventIdempotency: true, atomicWrite: true,
      serviceWorker: cfg.offline.serviceWorker !== false,
      proctorMarkOnly: cfg.security.proctorEnabled !== false
    }
  }));

  app.add('GET', '/api/config', ctx => ctx.send(publicConfig(cfg, bank, roster, { fingerprint })));
  app.add('GET', '/api/names', ctx => ctx.send({ names: roster.names }));

  // ---------- 题库（P0 修复） ----------
  // 学员：仅脱敏题（无 a / e），必须有效学员令牌
  app.add('GET', '/api/questions', ctx => {
    if (!needStudent(ctx)) return ctx.fail('unauthorized', 401);
    return ctx.send(Object.assign({ ok: true }, bank.sanitized(), { sessionId: cfg.sessionId }));
  });
  // 管理端：含答案解析，必须管理令牌；用于错题分析与成绩导出
  app.add('GET', '/api/admin/questions', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    return ctx.send(Object.assign({ ok: true }, bank.full(), { sessionId: cfg.sessionId }));
  });

  app.add('GET', '/api/student-status', ctx => {
    const n = ctx.query.get('name');
    if (!n || !roster.has(n)) return ctx.send({ found: false });
    const s = exam.get(n);
    return ctx.send({ found: true, name: n, status: s.status, attempts: s.attempts || 0,
                      max: cfg.maxAttempts, timeLimit: cfg.timeLimitSec,
                      remainingSec: exam._remainingSec(s), timedOut: exam._timedOut(s) });
  });

  // ---------- 登录 / 登出（加盐校验 + 限流 + TTL） ----------
  app.add('POST', '/api/admin/login', ctx => {
    if (!limiter.hit('admin-login:' + ctx.ip, cfg.security.maxLoginPerMinute || 5, 60000)) {
      return ctx.fail('尝试过于频繁，请 1 分钟后再试', 429);
    }
    if (!verifyAdmin(ctx.body.password || '')) return ctx.fail('口令错误', 401);
    const token = adminTokens.issue({ ip: ctx.ip, ua: ctx.ua.slice(0, 80) });
    return ctx.send({ ok: true, token, version: VERSION });
  });
  app.add('POST', '/api/admin/logout', ctx => {
    adminTokens.revoke(tok(ctx));
    return ctx.send({ ok: true });
  });

  app.add('POST', '/api/student/login', async ctx => {
    if (!limiter.hit('student-login:' + ctx.ip, (cfg.security.maxLoginPerMinute || 5) * 2, 60000)) {
      return ctx.fail('尝试过于频繁，请稍后再试', 429);
    }
    const cloudOpen = await cloud.readOpen(exam.studentOpen, exam);
    const gate = exam.gateOpen();
    const open = cloudOpen && gate.open;
    if (!open) {
      const msg = gate.reason === 'before' ? '未到开考时间，请稍后再进'
        : gate.reason === 'after' ? '本场考试已截止时间，请联系管理员'
        : '学员端暂未开放，请稍候或联系管理员开启';
      return ctx.send({ ok: false, closed: true, reason: gate.reason, msg }, 403);
    }
    if (cfg.requireStudentPw !== false && !verifyStudent(ctx.body.password || '')) return ctx.fail('密码错误', 401);
    const token = stuTokens.issue({ ip: ctx.ip });
    return ctx.send({ ok: true, token, version: VERSION });
  });
  app.add('POST', '/api/student/logout', ctx => {
    stuTokens.revoke(tok(ctx));
    return ctx.send({ ok: true });
  });

  // ---------- 考试流程 ----------
  app.add('POST', '/api/start', async ctx => {
    const b = ctx.body || {};
    if (!b.name || !roster.has(b.name)) return ctx.fail('姓名无效', 400);
    if (!needStudent(ctx)) return ctx.fail('未解锁，请在首页输入进入密码', 403);
    const s = exam.get(b.name);
    const cloudOpen = await cloud.readOpen(exam.studentOpen, exam);
    const gate = exam.gateOpen();
    const open = cloudOpen && gate.open;
    if (!open && s.status !== 'done') {
      const msg = gate.reason === 'before' ? '未到开考时间，请稍后再进'
        : gate.reason === 'after' ? '本场考试已截止时间，请联系管理员'
        : '学员端暂未开放，请稍候或联系管理员开启';
      return ctx.send({ ok: false, closed: true, reason: gate.reason, msg }, 403);
    }
    const r = exam.start(b.name, b.total, b.eventId, open);
    if (r.ok && !r.resume) stuTokens.bind(tok(ctx), b.name);
    return ctx.send(r, r.ok ? 200 : (r.code || 400));
  });

  // 逐题判分：唯一会下发"正确答案/解析"的学员接口，且一次只给当前题
  app.add('POST', '/api/reveal', ctx => {
    const b = ctx.body || {};
    if (!b.name || !roster.has(b.name)) return ctx.fail('姓名无效', 400);
    if (!needStudent(ctx, b.name)) return ctx.fail('未解锁或令牌与学员不匹配', 403);
    if (!limiter.hit('reveal:' + b.name, cfg.security.maxRevealPerSecond || 6, 1000)) {
      return ctx.fail('操作过快，请稍候', 429);
    }
    const r = exam.reveal(b.name, b.qid, b.pick, b.durationSec, b.eventId);
    return ctx.send(r, r.ok ? 200 : (r.code || 400));
  });

  // 进度：忽略客户端上报的 answers / score，服务端按 picks 重新派生
  app.add('POST', '/api/progress', ctx => {
    const b = ctx.body || {};
    if (!b.name || !exam.get(b.name)) return ctx.fail('姓名无效', 400);
    if (!needStudent(ctx, b.name)) return ctx.fail('未解锁或令牌与学员不匹配', 403);
    const r = exam.progress(b.name, b);
    return ctx.send(r, r.ok ? 200 : (r.code || 400));
  });

  // 监考事件：切屏/复制/剪切/右键/多标签/闲置，只记待审，绝不自动判罚 / 改分
  app.add('POST', '/api/proctor', ctx => {
    const b = ctx.body || {};
    if (!b.name || !roster.has(b.name)) return ctx.fail('姓名无效', 400);
    if (!needStudent(ctx, b.name)) return ctx.fail('unauthorized', 403);
    return ctx.send(exam.flagProctor(b.name, b));
  });

  app.add('GET', '/api/resume', ctx => {
    const name = ctx.query.get('name');
    if (!needStudent(ctx)) return ctx.fail('未解锁', 403);
    const s = exam.get(name);
    if (!s) return ctx.fail('not found', 404);
    if (s.status !== 'doing') return ctx.fail('not doing', 400);
    // 仅回传"该学员已作答题目"的对错与解析，绝不返回未作答题的答案
    const feedback = (s.revealed || []).map((r, i) => r ? { correct: !!r.correct, explanation: bank.at(i).e || '' } : null);
    const explanations = (s.revealed || []).map((r, i) => r ? (bank.at(i).e || '') : '');
    return ctx.send({
      ok: true, total: s.total || bank.count, current: s.current || 0, progress: s.progress || 0,
      picks: s.picks || [], qTimes: s.qTimes || [], durationSec: s.durationSec || 0,
      feedback, explanations, correctCount: (s.answers || []).filter(x => x === true).length,
      attemptNo: (s.attempts || 0) + 1, max: cfg.maxAttempts,
      remainingSec: exam._remainingSec(s)
    });
  });

  app.add('POST', '/api/submit', async ctx => {
    const b = ctx.body || {};
    if (!b.name || !exam.get(b.name)) return ctx.fail('姓名无效', 400);
    const s = exam.get(b.name);
    // 兼容兜底：服务端重启导致令牌丢失时，进行中的学员仍可交卷（留痕 legacy-fallback）
    const legacy = !needStudent(ctx, b.name) && s.status === 'doing';
    if (!needStudent(ctx, b.name) && !legacy) return ctx.fail('未解锁，无法提交', 403);
    const r = exam.submit(b.name, b.picks, b.qTimes, b.durationSec, b.eventId);
    if (r.ok && !r.duplicate && exam.lastCommit) await exam.lastCommit;
    if (legacy) d.appendAudit({ at: Date.now(), type: 'submit-legacy-fallback', name: b.name, extra: {} });
    return ctx.send(r, r.ok ? 200 : (r.code || 400));
  });

  // ---------- 管理端 ----------
  app.add('GET', '/api/state', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    return ctx.send(exam.snapshot({ cloud: cloud.health(), sseClients: hub.size }));
  });
  app.add('GET', '/api/stream', ctx => {
    if (!needAdmin(ctx)) { ctx.res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return ctx.res.end('unauthorized'); }
    return hub.add(ctx.req, ctx.res, exam.snapshot({ cloud: cloud.health() }));
  });
  app.add('POST', '/api/reset', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);  // v2.2 的 key= 旁路已移除
    const p = exam.resetAll();
    return Promise.resolve(p).then(() => ctx.send({ ok: true }));
  });
  app.add('POST', '/api/admin/clear-doing', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const n = exam.clearDoing();
    return ctx.send({ ok: true, cleared: n });
  });
  app.add('POST', '/api/admin/reset-student', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const name = ctx.body && ctx.body.name;
    if (!name || !roster.has(name)) return ctx.fail('姓名无效', 400);
    exam.resetStudent(name);
    return ctx.send({ ok: true });
  });

  // 监考人工复核闭环：confirmed / dismissed / pending；只记结论，不自动改分
  app.add('POST', '/api/admin/proctor-review', ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const b = ctx.body || {};
    const r = exam.reviewProctor(b.name, b.action, b.note, b.reviewer || 'admin');
    if (r.ok && exam.lastCommit) return Promise.resolve(exam.lastCommit).then(() => ctx.send(r));
    return ctx.send(r, r.ok ? 200 : (r.code || 400));
  });
  app.add('GET', '/api/admin/student-open', async ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const open = await cloud.readOpen(exam.studentOpen, exam);
    return ctx.send({ ok: true, open });
  });
  app.add('POST', '/api/admin/set-student-open', async ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const open = ctx.body && ctx.body.open !== false;
    exam.setOpen(open);
    if (exam.lastCommit) await exam.lastCommit;
    return ctx.send({ ok: true, open: exam.studentOpen });
  });
  app.add('POST', '/api/admin/toggle-student', async ctx => {
    if (!needAdmin(ctx)) return ctx.fail('unauthorized', 401);
    const cur = await cloud.readOpen(exam.studentOpen, exam);
    exam.setOpen(!cur);
    if (exam.lastCommit) await exam.lastCommit;
    return ctx.send({ ok: true, open: exam.studentOpen });
  });

  // ---------- 静态资源 ----------
  app.setFallback(ctx => {
    let p = ctx.u.pathname;
    if (p === '/') p = '/index.html';
    else if (p === '/admin') p = '/admin.html';
    const fp = path.resolve(PUBLIC_DIR, '.' + p);
    if (!fp.startsWith(PUBLIC_DIR)) { ctx.res.writeHead(403); return ctx.res.end('forbidden'); }
    fs.readFile(fp, (e, buf) => {
      if (e) { ctx.res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return ctx.res.end('not found'); }
      const ext = path.extname(fp).toLowerCase();
      // SW 脚本必须允许更新检查；其余静态资源保持 no-store
      if (p === '/sw.js') ctx.res.setHeader('Cache-Control', 'no-cache');
      ctx.res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      ctx.res.end(buf);
    });
  });
}

module.exports = { register };
