/**
 * 培训考试系统 v3.0 · 一键 SEA 打包（Windows 单文件 exe）
 *
 * 用法： node build/build-exe.mjs
 * 输出： ..\应用程序\职业技能考试系统.exe
 *
 * 双轨构建：
 *  - 默认：esbuild bundle + --experimental-sea-config + postject 注入（Node 22 已验证）
 *  - 未来：Node 25.5+ 内置 --build-sea 时，设 USE_BUILD_SEA=1 可试验新链；失败自动回退默认链
 * 构建目录固定为纯 ASCII 的 C:/tmp/seabuild/v3/app，避免中文路径导致工具链异常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 构建工具可能装在 v3 子目录，也可能被 npm 提升到上层（取决于上层是否有 package.json）
const NM = fs.existsSync('C:/tmp/seabuild/v3/node_modules/esbuild/bin/esbuild')
  ? 'C:/tmp/seabuild/v3/node_modules' : 'C:/tmp/seabuild/node_modules';
const BUILDER = path.dirname(NM);
const APP = 'C:/tmp/seabuild/v3/app';
const OUT = path.resolve(ROOT, '..', '应用程序', '职业技能考试系统.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true }, opts || {}));
  if (r.status !== 0) {
    const msg = (r.stdout || '') + (r.stderr || '');
    throw new Error('命令失败: ' + [cmd].concat(args).join(' ') + '\n' + msg.slice(-2000));
  }
  return (r.stdout || '').trim();
}
function tryRun(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true }, opts || {}));
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
function must(p, msg) { if (!fs.existsSync(p)) throw new Error(msg + ' -> ' + p); }
// 不用 fs.cpSync：本机 Node 22 在该 API 上复制含子目录的树时会异常终止（退出码 127）
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDirSync(a, b);
    else if (e.isFile()) { fs.copyFileSync(a, b); n++; }
  }
  return n;
}

// 1. 工具链检查
const esbuildBin = path.join(NM, 'esbuild/bin/esbuild');
const postjectCli = path.join(NM, 'postject/dist/cli.js');
must(esbuildBin, '缺少 esbuild，请先在 ' + BUILDER + ' 执行 npm install esbuild@0.28.2 postject --registry https://registry.npmmirror.com');
must(postjectCli, '缺少 postject');
const major = parseInt(process.versions.node.split('.')[0], 10);
const help = spawnSync(process.execPath, ['--help'], { encoding: 'utf8' }).stdout || '';
const canBuildSea = /--build-sea/.test(help) && major >= 25;
console.log('[1/7] Node ' + process.version + ' | 内置 --build-sea: ' + (canBuildSea ? '支持' : '不支持，使用已验证的 postject 链'));

// 2. 准备纯 ASCII 构建目录
fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
['server.js', 'package.json', 'session.json', 'students.json', 'questions.json', '.cloud.json', 'system.config.json']
  .forEach(f => { const s = path.join(ROOT, f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(APP, f)); });
['public', 'src', 'node_modules'].forEach(d => {
  const s = path.join(ROOT, d);
  if (fs.existsSync(s)) copyDirSync(s, path.join(APP, d));
});
fs.copyFileSync(path.join(ROOT, 'build/sea-entry.cjs'), path.join(APP, 'sea-entry.cjs'));
fs.copyFileSync(path.join(ROOT, 'build/sea-config.json'), path.join(APP, 'sea-config.json'));
console.log('[2/7] 构建目录就绪: ' + APP);

// 3. esbuild 打成单 CJS
run(process.execPath, [esbuildBin, 'sea-entry.cjs', '--bundle', '--platform=node', '--format=cjs',
                       '--target=node' + major, '--outfile=bundle.cjs'], { cwd: APP });
console.log('[3/7] bundle.cjs ' + fs.statSync(path.join(APP, 'bundle.cjs')).size + ' B');

// 4. 生成 SEA blob
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: APP });
const blob = path.join(APP, 'sea-prep.blob');
must(blob, '未生成 sea-prep.blob');
console.log('[4/7] sea-prep.blob ' + fs.statSync(blob).size + ' B');

// 5. 可选：Node 25.5+ 内置构建（试验性，失败自动回退）
let exe = path.join(APP, 'ExamAdmin.exe');
let builtByNewChain = false;
if (process.env.USE_BUILD_SEA === '1' && canBuildSea) {
  const r = tryRun(process.execPath, ['--build-sea', 'sea-config.json'], { cwd: APP });
  const candidate = path.join(APP, 'ExamAdmin.exe');
  if (r.ok && fs.existsSync(candidate) && fs.statSync(candidate).size > 1024 * 1024) {
    builtByNewChain = true;
    console.log('[5/7] 使用内置 --build-sea 生成 exe');
  } else {
    console.log('[5/7] --build-sea 未产出可用 exe，回退 postject 链：' + r.out.slice(-300));
  }
}
if (!builtByNewChain) {
  const sysNode = 'C:/Program Files/nodejs/node.exe';
  fs.copyFileSync(fs.existsSync(sysNode) ? sysNode : process.execPath, exe);
  console.log('[5/7] 已复制 Node 宿主为 exe 骨架');
}

// 6. 注入 blob
if (!builtByNewChain) {
  run(process.execPath, [postjectCli, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE], { cwd: BUILDER });
}
console.log('[6/7] 注入完成，exe ' + fs.statSync(exe).size + ' B');

// 7. 交付
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(exe, OUT);
console.log('[7/7] 产物: ' + OUT + ' (' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB)');
console.log('构建链: ' + (builtByNewChain ? 'node --build-sea (Node ' + major + ')' : 'esbuild + postject (Node ' + major + ')'));
