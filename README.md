# Vocational Exam System

> A local-first Windows desktop exam system for vocational skills theory tests. Single-file EXE (Node SEA) with external frontend assets — no internet or database required to run an offline closed-book exam.

[中文](#中文说明) · [English](#english)

---

## English

### What it is

An **offline-first theory exam tool** for training institutions. The admin console imports the roster and question bank, configures a session and monitors progress; students answer under a time limit, with tab-switch tracking and instant scoring on submission.
Exam data is stored locally in `data.json` by default. **Cloud publishing is entirely the deployer's responsibility**: this repository contains no account, no publish key and no hosted URL.

### Key features

- **Server-side grading**: answers are never sent to the browser; each response is graded on the server.
- **Time limit and forced submit**: configurable duration (45 minutes by default), red warning in the final stretch, voice prompts, forced submission at timeout.
- **Anti-cheating trails**: tab-switch flags, login throttling and grading throttling — recorded, never auto-penalized.
- **Backup accounts**: accounts starting with `备用` can take the exam but are excluded from official headcount and completion rates.
- **Offline-ready**: Service Worker plus an outbox with replay — answers survive network loss.
- **5 themes**: selectable on the big screen, synchronized across windows via `localStorage`.
- **WeChat share card**: generates a share page with a QR code pointing to the deployer's own URL.
- **Single-file EXE**: Node SEA packaging; the `public/` folder and config files are external, so UI changes need no kernel rebuild.

### Tech stack

Node.js 22 · Node SEA · native HTTP module (zero runtime dependencies) · Service Worker · SSE · Python 3.13 (build tools)

### Layout

```
src/core/         Configuration, question bank, roster, grading, security policy
src/http/         Routing and API endpoints
src/realtime/     Server-sent events
src/store/        Local / cloud storage adapters
public/           Student UI, admin UI, share page and styles
tools/            Question-bank builder, roster importer, self-check scripts
build/            SEA packaging configuration
cloud/            Optional cloud database schema
docs/             Technical specification and usage guides (bilingual abstracts; Chinese body)
session.example.json     Session config sample (change all CHANGE_ME values)
students.example.json    Roster sample (fictional names only)
```

### Quick start

```bash
node server.js                      # requires Node.js 22+
# open http://localhost:3000
# admin console: /admin
node tools/selftest_v3.mjs          # self-check
```

### Publishing to the cloud (important)

This project **does not include or use anyone's cloud publishing account**. To deploy publicly:

1. Register your own account on a cloud platform and obtain **your own** `publishableKey` and endpoint.
2. Create your own `.cloud.json` using your credentials (see your platform's docs). This file is gitignored.
3. Publish with your own account and use your own domain.

> `data.json`, `students.json` and `questions.json` samples contain no personal data.

### License

MIT

---

<a id="中文说明"></a>
## 中文说明

### 是什么

面向培训机构的**离线理论考核**工具：管理端导入名单与题库、配置场次、监控考试；学员端限时答题、切屏留痕、交卷即出分。
所有考试数据默认保存在本机 `data.json`；如需云端发布，由**部署者自行准备云端账号**，本项目不附带任何账号或发布凭据。

### 核心特性

- **服务端判分**：答案不下发前端，逐题服务端校验，防翻页偷看
- **限时与交卷**：可配置考试时长（默认 45 分钟），最后阶段红字提醒 + 语音播报，到时强制交卷
- **防作弊留痕**：切屏标记、登录限流、判分限流，只记录不自动判罚
- **备用号统计**：`备用` 开头账号可参加考试但不计入正式人数与完成率
- **离线可用**：Service Worker + outbox 重放，断网不丢答案
- **5 套主题**：大屏选择，`localStorage` 跨窗口同步，主题连模块布局一起变
- **微信分享卡片**：可生成带二维码的分享页（二维码指向部署者自己的地址）
- **单文件 EXE**：Node SEA 打包，`public/` 与配置文件外置，改界面/配置无需重打包内核

### 技术栈

Node.js 22 · Node SEA（Single Executable Application）· 原生 HTTP 模块（零运行时依赖）· Service Worker · SSE 实时推送 · Python 3.13（题库/名单构建工具）

### 运行

```bash
node server.js                      # 需 Node.js 22+
# 打开 http://localhost:3000
# 管理端入口 /admin
node tools/selftest_v3.mjs          # 自检
```

### 关于公网发布（重要）

本项目**不含也不使用任何人的云端发布账号**。如需发布到公网，请：

1. 自行注册并申请一个云端平台账号，获取你自己的 `publishableKey` 与 endpoint
2. 自建 `.cloud.json`（格式参考你所用平台的文档），填入**你自己的**凭据 — 该文件已加入 `.gitignore`，不会提交
3. 用你自己的账号发布、用你自己的域名访问

> `data.json`、`students.json`、`questions.json` 均为示例/占位数据，不含任何真人信息。

### 许可

MIT
