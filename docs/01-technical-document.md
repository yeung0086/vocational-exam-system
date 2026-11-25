<!-- bilingual: en/zh -->
> **Technical Specification (Current)**
> **English Abstract**: Current technical specification of the vocational exam system: architecture, configuration, data model, security policy and deployment.

---

# 培训考试系统 · 现行技术文档（本地 v3.1.0 / 架构基线 v3.0，2026-11-23）

> 本文是**现行系统的唯一技术事实来源**。`文档\历史版本_v1.0\` 写于 2026-10-28 局域网时代，
> 「零第三方依赖」「不要绑定公网」「只适合局域网」等表述**已作废**；`文档\历史版本_v2.2_源码快照\`
> 是升级前基线，仅供回退对照。变更清单见 `03_v3.0升级说明.md`。

---

## 1. 结论先行

v3.0 把 v2.2 的单体 `server.js`（26 KB、19 个接口、答案随题库下发）重构为**四层 11 模块**，
并完成三项实质升级：

| 维度 | v2.2 | v3.0 |
|---|---|---|
| 题库安全 | `GET /api/questions` 无鉴权且 100 题全带 `a`/`e` | 必须令牌；学员只见脱敏题（无答案/解析），答案经 `POST /api/reveal` 逐题下发 |
| 判分 | 服务端重判，但客户端掌握全部答案、进度对错可伪造 | 服务端为唯一真值；客户端 `answers`/`score` 一律丢弃；`qid` 映射 + 跳题拦截 |
| 代码结构 | 单文件 26 KB 混杂配置/路由/状态/云 | `core` / `store` / `http` / `realtime` 分层，`server.js` 只剩装配 |
| 可靠性 | `writeFileSync` 直写、无幂等、无审计 | 原子写（tmp+rename）、`eventId` 幂等、审计 JSONL、SSE 心跳与背压 |
| 弱网 | 交卷重试 3 次，失败即丢 | Service Worker + IndexedDB outbox，联网后按序幂等重放 |
| 防作弊 | 无 | 切屏 ≥3 秒且累计 3 次才「标记待审」，不自动判罚 |
| 依赖 | 云 SDK `dev` 快照、`engines>=18` | 正式版 **0.1.4**、`engines>=22` |

**验证**：`node tools\selftest_v3.mjs` → **46/46 通过**；`node tools\doctor.mjs` → 0 ERROR / 0 WARN / 37 INFO；干净目录单文件 exe 全链路通过；
真实云端连通（reads=3 / failures=0）。

---

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│ HTTP 层  src/http/router.js（安全头 / body 限额 / 错误处理）      │
│          src/http/routes.js（24 个 API，显式令牌校验）            │
├─────────────────────────────────────────────────────────────────┤
│ 实时层   src/realtime/sse.js（连接池 / 20s 心跳 / 1MB 背压断开）  │
├─────────────────────────────────────────────────────────────────┤
│ 核心层   src/core/exam.js     状态机 + 幂等 + 快照聚合            │
│          src/core/bank.js     题库加载 / 脱敏 / 判分 / qid 映射   │
│          src/core/security.js scrypt 口令 / TokenPool / 限流      │
│          src/core/config.js   场次配置 / 指纹 / 公开配置           │
│          src/core/roster.js   名单校验                            │
│          src/core/runtime.js  SEA 判定 / 路径 / 版本 / 哈希        │
├─────────────────────────────────────────────────────────────────┤
│ 存储层   src/store/local.js   原子写 data.json + 审计 JSONL       │
│          src/store/cloud.js   云 SDK 适配（重试 / 串行 / TTL）     │
├─────────────────────────────────────────────────────────────────┤
│ 入口     server.js            仅装配依赖、注册路由、启动与优雅退出 │
└─────────────────────────────────────────────────────────────────┘
```

所有写操作必须经 `Exam._commit()`：`审计 → 原子落盘 → 云端同步 → SSE 广播`。
`Exam.lastCommit` 是 Promise，交卷与开关接口会 `await` 它，确保落云后再响应。

### 三种运行形态

| | 云端 Web 实例 | Windows exe | 工程源码 / 自检 |
|---|---|---|---|
| 入口 | 公网 HTTPS + `?sharecode=` | 双击 `应用程序\职业技能考试系统.exe` | `node server.js` / `selftest_v3.mjs` |
| 运行形态 | 源码（平台 npm install） | **SEA 单文件**（`node:sea.isSea() === true`） | 源码 |
| 静态资源 | 磁盘 `public/` | 内嵌 assets，exe 同目录外置文件优先 | 磁盘 `public/` |
| 数据 | 云端 + 实例本地 `data.json` | 云端 + exe 同目录 `data.json` | 由 `DATA_DIR` 指定 |
| 当前版本 | **11-03 旧版，未重新发布** | **v3.1.0** | **v3.1.0** |

> 三种形态互不直接通信，靠云端 `exam_results` / `exam_config` 同步；开关读取有 3 秒 TTL 缓存。

---

## 3. 技术栈与版本（2026-11-09 实查）

| 项 | 值 | 备注 |
|---|---|---|
| Node（源码自检） | v22.23.2 | WorkBuddy 内置运行时 |
| Node（exe 宿主） | **v24.22.0** | `C:\Program Files\nodejs\node.exe`，比 v2.2 的 v22 新 |
| Node 上游 | **v26.13.0 Lithium LTS**（2026-10-28，支持至 2029-04） | 本机未安装，暂不迁移；Node 22 将于 2027-04-30 EOL |
| `engines` | `>=22` | 已从 `>=18` 修正（18/20 均已 EOL） |
| 云 SDK | **`@tencent-ai/workbuddy-cloud-sdk@0.1.4`** | 从 `0.1.4-dev.ca27990...` 升为正式版，API 逐一对照一致 |
| esbuild | 0.28.2 | 当前最新 |
| postject | 1.0.0-alpha.6（2023） | **仍是风险点**：3.5 年未更新。Node ≥25.5 可用内置 `--build-sea` 摆脱它 |
| 前端 | 原生 HTML/CSS/JS + Service Worker + IndexedDB | 无框架、无前端构建 |

`build\build-exe.mjs` 已做双轨探测：默认走已验证的 `esbuild + postject`；
检测到 Node ≥25.5 且原生支持 `--build-sea` 时，设 `USE_BUILD_SEA=1` 可试验新链，失败自动回退。

---

## 4. 安全模型（v3.0 核心变化）

### 4.1 已闭环

| 风险 | 修复 |
|---|---|
| 学员 F12 拿到 100 题答案 | `bank.sanitized()` 只返回 `no/qid/cat/type/q/o/diff`；自检验证 100/100 题零泄露 |
| 无鉴权访问题库 | `/api/questions` 必须有效学员令牌；`/api/admin/questions` 必须管理令牌 |
| 客户端伪造分数 | `/api/progress` 丢弃客户端 `answers`；`/api/submit` 以服务端记录的 `picks` 判分，篡改留痕 `client-mismatch`。自检把 100 题全改对，服务端仍只给 1 分 |
| 跳题批量套答案 | `reveal` 校验 `qid` 且 `index ≤ reached`，跳到第 50 题返回 403 |
| 无盐口令哈希 / 无限流 | scrypt 加盐 + `timingSafeEqual`；登录 5 次/分钟、reveal 6 次/秒 |
| token 永不过期 / 可冒名 | 管理 24h（活跃续期）、学员 12h；`/api/start` 把 token 绑定姓名，跨学员提交 403 |
| `key=<管理员口令>` 绕过登录 | `/api/reset` 的 `key=` 旁路已移除，必须管理令牌 |
| 断电写坏 `data.json` | `tmp + fsync + rename` 原子写 |
| 重复重放计数 | 所有写操作带 `eventId`，`Exam.seenEvents` 10 分钟 TTL 去重 |
| 无痕操作 | `audit.jsonl` 记录 type/name/at，2 MB 轮转；自检确认不含答案/口令 |

### 4.2 仍存在、需平台侧配合

- **云端 RLS 全开**：`publishableKey` 随包分发，`anon` 对两表有 CRUD + `USING(true)`。
  绕过服务端直接改库仍可能。彻底修复需要平台提供 service_role / 云函数，见
  `cloud\schema_v3_建议.sql`（**设计稿，勿执行**）。
- **线上公网实例仍是 11-03 旧代码**，旧逻辑会下发答案。这是当前唯一实际敞口，
  重新发布需用户单独确认（会覆盖线上内容）。
- exe 未做代码签名，SmartScreen 会提示「未知发布者」。

### 4.3 HTTP 安全头

`X-Content-Type-Options: nosniff`｜`X-Frame-Options: SAMEORIGIN`｜`Referrer-Policy: no-referrer`｜
`COOP: same-origin`｜CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; …; frame-ancestors 'self'`。

> `'unsafe-inline'` 是兼容现有内联脚本的过渡设置；若要收紧需把内联脚本外置 + nonce。

---

## 5. 状态机与事件幂等

状态：`idle → doing → done`。`Exam` 暴露 `start / reveal / progress / submit / resetAll /
resetStudent / clearDoing / setOpen / flagProctor / snapshot`。

- `reveal(name, qid, pick, durationSec, eventId)`：服务端判分，写 `s.picks/qTimes/answers/revealed`，
  返回 `{correct, correctIndexes, explanation, answered, correctCount, progress}`。
  同一题重复请求直接返回缓存反馈，不重复计数。
- `progress()`：用 `bank.gradeAll(picks)` 从选项**重新派生**对错，不信任客户端 `answers`。
- `submit()`：优先用服务端 `s.picks`；只有服务端完全无记录时才用客户端 picks 兜底并标 `client-fallback`；
  两者不一致标 `client-mismatch`。返回 `{score, total, pct, passed, integrity}` 供结果页渲染。
- `flagProctor()`：切屏 ≥3 秒计一次，累计 3 次置 `flagged`，只写审计与快照，**不改成绩、不强制交卷**。

`GET /api/resume` 只回传该学员**已作答题目**的对错（`feedback`），绝不返回未作答题答案。

---

## 6. 离线韧性

| 层 | 实现 |
|---|---|
| `public/sw.js` | 只缓存页面外壳（HTML/CSS/二维码/offline.js）；导航 network-first，断网回退缓存；**所有 `/api/*` 与 SSE 不拦截** |
| `public/offline.js` | IndexedDB outbox（不可用时降级 localStorage），`ExamOffline.autoFlush()` 在 `online` 事件与每 15 秒重放 |
| 幂等 | 每条排队请求自带 `eventId`；服务端按 `seenEvents` 去重 |
| 前端降级 | reveal 失败时提示「已保存（离线），联网后统一判分」，允许继续下一题；交卷失败提示「答卷已缓存，联网后自动提交」 |

> 不使用 Background Sync：微信内置浏览器与部分国产内核不支持。

---

## 7. 云端与数据

### 7.1 表结构（沿用 v2.2，v3.0 无需任何 DDL）

`exam_results`（`name` 主键，status/progress/total/current/score/correct/duration_sec/attempts/
answers/picks/q_times/started_at/finished_at/updated_at）与 `exam_config`（key/value_json/updated_at）。
完整 DDL 见 `cloud\schema.sql`。

`src\store\cloud.js` 收敛了所有 SDK 调用，显式剔除 `revealed`/`integrity` 等 v3 本地字段，
保证旧表结构兼容；新增 3 次重试、配置串行写、失败计数与 `/api/health` 暴露。

### 7.2 写入时机

| 动作 | 本地 | 云端 |
|---|---|---|
| start / reveal / progress / reset | 原子写 | fire-and-forget upsert 单学员 |
| **submit** | 原子写 | **await 落云后响应** |
| set-open / toggle | 原子写 | await 串行写 config |
| proctor-blur | 原子写 + 审计 | 不写（高频） |

启动顺序：先恢复本地 `data.json` → 云端 `loadAll()` 成功则覆盖并广播。
`CLOUD_DISABLE=1` 可强制纯本地；`DATA_DIR` 可重定向运行时数据目录。

### 7.3 多场次与 RLS 治理（未执行）

`cloud\schema_v3_建议.sql` 给出「只追加事件表 + 视图」的过渡方案与 `session_id` 分区目标结构，
并列出需向平台确认的 4 个前置条件。**本轮未执行任何 DDL**，`cloud.partitionBySession` 默认 `false`。

---

## 8. API 清单（v3.0，24 个）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 版本、Node、SEA、指纹、云状态、SSE 连接数、特性 |
| GET | `/api/config` | 公开 | 场次展示配置（**绝不含口令**）+ features |
| GET | `/api/names` | 公开 | 名单 |
| GET | `/api/questions` | **学员令牌** | **脱敏题库** + qid |
| GET | `/api/admin/questions` | **管理令牌** | 全量题库（含答案解析，导出用） |
| GET | `/api/student-status` | 公开 | 该学员状态/剩余次数 |
| POST | `/api/admin/login` `/api/admin/logout` | 限流 | 管理登录/登出 |
| POST | `/api/student/login` `/api/student/logout` | 限流+门禁 | 学员解锁/登出 |
| POST | `/api/start` | 学员令牌 | 开考 / 续答；绑定 token 与姓名 |
| POST | `/api/reveal` | 学员令牌+限流 | **逐题服务端判分** |
| POST | `/api/progress` | 学员令牌 | 进度；服务端重新派生对错 |
| POST | `/api/proctor` | 学员令牌 | 切屏标记待审 |
| GET | `/api/resume` | 学员令牌 | 续答进度 + 已作答题反馈 |
| POST | `/api/submit` | 学员令牌 | 交卷，返回**服务端分数** |
| GET | `/api/state` | 管理令牌 | 大屏全量快照 |
| GET | `/api/stream` | 管理令牌 | SSE（含心跳、id 序号） |
| POST | `/api/reset` | 管理令牌 | 清空（**key 旁路已移除**） |
| POST | `/api/admin/clear-doing` | 管理令牌 | 清卡住的「答题中」 |
| POST | `/api/admin/reset-student` | 管理令牌 | 单学员重置重考 |
| GET | `/api/admin/student-open` | 管理令牌 | 读开关（云端最新值） |
| POST | `/api/admin/set-student-open` | 管理令牌 | 设开关 |
| POST | `/api/admin/toggle-student` | 管理令牌 | 一键切换 |

静态：`/`、`/admin`、`/share.html`、`/student.css`、`/admin.css`、二维码、`/sw.js`、`/offline.js`。
`/api/stream` 与所有 `/api/*` 不进 SW 缓存；目录穿越由 `path.resolve + startsWith` 拦截。

---

## 9. 配置与场次包

优先级：**环境变量 > session.json > 内置默认**。

| 环境变量 | 说明 |
|---|---|
| `PORT` | 默认 3000 |
| `ADMIN_PASSWORD` / `ADMIN_KEY` | 覆盖管理口令 |
| `STUDENT_PASSWORD` / `REQUIRE_STUDENT_PW` | 覆盖学员口令 / 是否启用门禁 |
| `MAX_ATTEMPTS` / `TIME_LIMIT_SEC` / `PASS_RATE` | 覆盖次数 / 时长 / 及格线 |
| `SESSION_ID` | 覆盖场次编号 |
| `DATA_DIR` | **v3 新增**，运行时数据目录 |
| `CLOUD_DISABLE=1` | **v3 新增**，强制离线 |
| `NO_AUTO_OPEN=1` | **v3 新增**，exe 不自动弹大屏（测试用） |
| `USE_BUILD_SEA=1` | 构建脚本试验 Node ≥25.5 原生 SEA |

`session.json` 的 v3 新增块（`tools\build_session.py` 换场次时会保留用户自定义值）：

```json
{
  "schemaVersion": 3,
  "sessionId": "2026-11-【地区】【地区】家政-01",
  "questionPolicy": { "mode": "all", "sampleSize": null, "shuffle": false, "seed": "" },
  "security": { "revealMode": "server", "proctorEnabled": true,
                "blurThresholdSec": 3, "blurFlagCount": 3,
                "maxLoginPerMinute": 5, "maxRevealPerSecond": 6 },
  "offline": { "serviceWorker": true, "outbox": true, "replayBatchSize": 20 },
  "cloud": { "partitionBySession": false }
}
```

- `questionPolicy.shuffle` 默认 **false**（保持「题库行序即判分顺序」的既有约定）。置 true 后由
  `sessionId + 题库指纹` 作种子统一乱序，服务端用 `qid` 映射判分，前端仍按返回顺序展示。
- 换场次：`场次包\场次配置.xlsx` → `一键更新.bat` → 重启。名单/题量以生成后的 JSON 实际行数为准（当前 100 题 / 52 人）。

---

## 10. 构建与自检

```powershell
cd "C:\Users\Administrator\Desktop\培训考试系统\工程源码"
node tools\selftest_v3.mjs     # 46 项端到端，独立 3399 端口 + 临时 DATA_DIR，不碰线上
node tools\doctor.mjs          # 只读工程体检（--json 仅出 JSON，结果落盘 doctor_result.json）
node build\build-exe.mjs       # 一键出 exe → ..\应用程序\职业技能考试系统.exe
```

`build-exe.mjs` 7 步：工具链探测 → 复制到纯 ASCII 构建目录 → esbuild bundle →
`--experimental-sea-config` 生成 blob → 复制 Node 宿主 → postject 注入 → 交付。
**注意**：本机 Node 22 的 `fs.cpSync` 复制目录树会异常终止（退出码 127），脚本改用显式递归复制。

产物：`应用程序\职业技能考试系统.exe` 当前为 **v3.1.0，94,556,160 B（90.2 MB）**，内嵌 13 个 assets
（3 份 JSON + `.cloud.json` + 9 个 public 文件，含 `sw.js` / `offline.js`）。下方 2026-11-09 表为旧版历史验证记录。

### 验证记录（2026-11-09）

| 项 | 结果 |
|---|---|
| 源码自检 | **38/38 PASS**（含重启恢复、审计不含答案、篡改判分、跨学员 403） |
| 干净目录 exe（仅 1 个文件） | health v3.0.0 / sea=true / Node v24.22.0；8 个静态资源全 200 |
| exe 内嵌场次 | 100 题、32 人、指纹一致；学员题库 0 泄露；管理题库含解析 |
| exe 判分链路 | 开考 → reveal correct=true → 篡改 100 题交卷得 **1 分**（`client-mismatch`） |
| 真实云端 | SDK 0.1.4 连通，reads=3 / writes=0 / failures=0；开关读回 `true` |
| 换场次脚本 | 生成 JSON 与原文件逐字节一致，v3 配置块完整 |

---

## 11. 运维流程与排障

**开考前**：确认大屏「学员端」开放 → 用备用账号走一遍完整流程 → 导出一次空成绩验证导出可用 →
确认 `/api/health` 的 `cloud.available=true` 且 `failures=0`。

| 现象 | 排查 |
|---|---|
| 学员端打不开 | 查开关 `/api/admin/student-open`；线上实例需带 `?sharecode=` |
| 题库加载失败 / 反复回门禁 | 学员令牌过期（12h）或被绑定其他姓名；重新输入进入密码 |
| 「已保存（离线）」 | 正常降级：outbox 会重放，成绩不受影响；恢复网络后看大屏是否更新 |
| 大屏断连 | SSE 自动重连；v3 在 `onopen` 主动拉一次全量快照补漏帧 |
| 交卷一直转圈 | 云端写入重试 3 次最多约 1 秒；失败则本地缓存 + 自动重放 |
| 云端写入失败 | 看 `/api/health` 的 `cloud.lastError`；本地 `data.json` 仍是完整备份 |
| exe 双击无窗口 | 检查是否设了 `NO_AUTO_OPEN=1`；或 Edge 路径异常，手动开 `http://localhost:3000/admin` |

**红线**：考试进行中禁止清空/重置/DDL；不要用真实学员测试；名单题库改完必须重启；
切屏标记仅供人工复核，禁止自动判罚。

---

## 12. 已知限制与待办（按优先级）

1. **线上公网实例仍是 11-03 旧代码**（会下发答案）——重新发布需单独确认，且发布前导出数据。
2. **云端 RLS 未收紧** —— 依赖平台是否提供服务端凭据/云函数；`schema_v3_建议.sql` 仅为设计稿。
3. **Node 26 LTS 未迁移** —— 本机 22/24，exe 宿主 24.22.0；Node 22 于 2027-04-30 EOL，
   建议在 2027 年前评估 26 + 原生 `--build-sea`，同时摆脱 postject alpha.6。
4. **多场次分区未做** —— 现仍靠「换场次前清空云端」规避同名串数据。
5. **CSP 仍允许 `'unsafe-inline'`** —— 收紧需外置内联脚本 + nonce。
6. **exe 未代码签名** —— SmartScreen 提示属预期。
7. 前端离线 reveal 重放成功后不回补解析（成绩正确，但该题无解析展示）。
8. `tools\selfcheck.mjs` 是 v1.0 历史自检，因题库接口改为需令牌而**已弃用**（文件头已标注）；
   现行自检统一用 `tools\selftest_v3.mjs`。
