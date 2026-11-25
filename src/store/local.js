'use strict';
/** v3.0 本地存储层：原子写（临时文件 + rename，防断电半文件）、审计 JSONL、启动恢复。 */
const fs = require('fs');
const path = require('path');

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);   // Windows 下同名 rename 可覆盖
}

function loadData(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function appendAudit(file, evt) {
  try {
    // 审计只记元数据，绝不写答案、解析、口令
    fs.appendFileSync(file, JSON.stringify(evt) + '\n', 'utf8');
  } catch (_) { /* 审计失败不影响考试 */ }
}

/** 日志按 2MB 轮转，避免长时间运行无限增长。 */
function rotateAudit(file, maxBytes) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= (maxBytes || 2 * 1024 * 1024)) return;
    const bak = file + '.1';
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
    fs.renameSync(file, bak);
  } catch (_) {}
}

module.exports = { atomicWrite, loadData, appendAudit, rotateAudit };
