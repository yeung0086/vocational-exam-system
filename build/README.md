<!-- bilingual: en/zh -->
> **SEA Build Guide**
> **English Abstract**: How to rebuild the Windows single-file executable with Node SEA. Covers the one-click script, the dual-track build chain, dependencies, file responsibilities and verification. A session change does NOT require a rebuild.

---

# SEA 构建（v3.0）

把 `工程源码\` 重新打包成 Windows 单文件 exe。日常换场次**不需要**重打包（见 `../docs/session-guide.md`）；
只有改了引擎代码、静态资源或云 SDK 才需要。

## 一键构建

```powershell
cd "<repository-root>"
node build\build-exe.mjs
```

产物自动写到 `..\应用程序\职业技能考试系统.exe`。脚本 7 步：

| 步 | 动作 |
|---|---|
| 1 | 探测 Node 版本与工具链；检测是否支持内置 `--build-sea` |
| 2 | 清理并填充纯 ASCII 构建目录 `C:\tmp\seabuild\v3\app` |
| 3 | esbuild 把 `sea-entry.cjs` + `server.js` + `src\*` + 云 SDK 打成 `bundle.cjs` |
| 4 | `node --experimental-sea-config sea-config.json` 生成 `sea-prep.blob` |
| 5 | 复制 Node 宿主（`C:\Program Files\nodejs\node.exe`，当前 v24.22.0）为 exe 骨架 |
| 6 | postject 注入 `NODE_SEA_BLOB` + sentinel fuse |
| 7 | 复制到 `应用程序\` 并输出大小 |

### 双轨构建

- **默认链**（已验证）：esbuild + `--experimental-sea-config` + postject。
- **新链**（试验）：Node ≥25.5 原生支持 `--build-sea` 时，设 `USE_BUILD_SEA=1` 可试用；
  若未产出可用 exe，脚本自动回退默认链。这样可摆脱 postject（1.0.0-alpha.6，2023 年后无更新）。

### 依赖

```
mkdir -p /c/tmp/seabuild/v3 && cd /c/tmp/seabuild/v3
npm install esbuild@0.28.2 postject@1.0.0-alpha.6 --registry https://registry.npmmirror.com
```
脚本会同时探测 `C:\tmp\seabuild\v3\node_modules` 与上层 `C:\tmp\seabuild\node_modules`
（npm 可能被上层 `package.json` 提升安装位置）。

## 文件职责

| 文件 | 用途 |
|---|---|
| `sea-entry.cjs` | SEA shim：拦截 `fs.readFileSync/readFile/existsSync`，把名单/题库/场次/`.cloud.json`/`public` 从内嵌 assets 读出；**exe 同目录存在同名外部文件时优先读外部**；保留 `process.pkg` 仅兼容旧快照 |
| `sea-config.json` | 入口 `bundle.cjs`、blob 输出、**13 个内嵌资源**（v3 新增 `public/sw.js`、`public/offline.js`） |
| `build-exe.mjs` | 上述一键脚本 |

> **本机坑**：Node 22.22.2 的 `fs.cpSync` 复制含子目录的树会异常终止（退出码 127，无异常输出）。
> `build-exe.mjs` 已改用显式递归 `copyDirSync`。若自行写构建脚本，请勿直接用 `fs.cpSync`。

## 自行构建（等价手工命令）

```bash
cd /c/tmp/seabuild/v3/app
node ../../node_modules/esbuild/bin/esbuild sea-entry.cjs --bundle --platform=node \
     --format=cjs --target=node22 --outfile=bundle.cjs
node --experimental-sea-config sea-config.json
cp "/c/Program Files/nodejs/node.exe" ExamAdmin.exe
cd ..
node node_modules/postject/dist/cli.js app/ExamAdmin.exe NODE_SEA_BLOB \
     app/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

postject 提示 `warning: The signature seems corrupted!` 属正常（原 node.exe 数字签名失效），不影响运行。

## 验证（2026-11-09）

- 干净目录**只放 exe 一个文件**启动：`/api/health` 返回 `version=3.0.0 / sea=true / Node v24.22.0`。
- 8 个静态资源全 200（含 `sw.js`、`offline.js`）；内嵌场次 100 题 / 32 人。
- 学员题库 0 答案泄露；开考 → 逐题 reveal → 篡改交卷得 1 分；大屏快照版本/指纹正确。
- 测试时设 `NO_AUTO_OPEN=1` 可禁止自动弹大屏，`DATA_DIR=...` 可把 `data.json` 重定向到临时目录。
