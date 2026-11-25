'use strict';
/**
 * v3.0 运行时层：统一判定运行形态、解析所有路径、提供版本与哈希工具。
 * - 源码模式：BASE = 工程源码目录（__dirname 上溯两级）
 * - SEA/packaged 模式：BASE = exe 所在目录（可写，且支持外置场次包优先）
 * v2.2 用伪造 process.pkg 触发打包分支；v3.0 改用官方 node:sea.isSea()，保留兼容回退。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '3.1.0';
const BUILD_TAG = 'v3.1.0-20261123';

function detectSea() {
  try { return !!require('node:sea').isSea(); }
  catch (_) { return false; }
}

const isSea = detectSea();
const isPackaged = isSea || !!process.pkg;
const BASE = isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(BASE, 'public');
// 运行时数据可重定向到独立目录（自检 / 只读安装目录场景），默认仍在 BASE
const DATA_BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : BASE;
const DATA_FILE = path.join(DATA_BASE, 'data.json');
const AUDIT_FILE = path.join(DATA_BASE, 'audit.jsonl');

/** 场次文件统一入口：SEA 下由 sea-entry.cjs 拦截，外部真实文件优先、否则读内嵌 assets。 */
function cfgPath(name) { return path.join(BASE, name); }
function readJSON(name) { return JSON.parse(fs.readFileSync(cfgPath(name), 'utf8')); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function shortHash(s, n) { return sha256(s).slice(0, n || 16); }
function randomId(bytes) { return crypto.randomBytes(bytes || 16).toString('hex'); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8'
};

module.exports = {
  VERSION, BUILD_TAG, isSea, isPackaged, BASE, PUBLIC_DIR, DATA_FILE, AUDIT_FILE,
  cfgPath, readJSON, sha256, shortHash, randomId, MIME
};
