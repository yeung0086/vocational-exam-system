<!-- bilingual: en/zh -->
> **Tool Usage Guide**
> **English Abstract**: Guide to the bundled one-click utilities for config generation and workbook import.

---

# 一键工具使用说明（旧版系统 · 成熟项目保留版）

本目录有两个独立工具，互不依赖，双击即可运行：

## 1. 一键上传信息表.exe

**作用**：把脱敏后的场次 Excel（名单 / 题库 / 场次信息）写入旧版系统。

**步骤**：
1. 双击打开 → 在弹窗里选择脱敏表格（默认定位到 `D:\work Buddy\projects\mbo-test\脱敏表格_20261125\`）。
2. 核对弹窗里显示的名单人数、题库题数、标题。
3. 点"是"确认。

**安全设计**：
- 只覆盖 `工程源码` 下的 `students.json`、`questions.json`、`session.json` 三个文件。
- **绝不碰 `data.json`（考试成绩）**。
- 覆盖前自动把旧三份 JSON 备份到 `工程源码\_换场次备份\时间戳\`。
- 名单里的"备用账号1/2"作为备用号追加，不计入正式人数统计。

**注意**：上传后若系统正在运行，需重启服务新场次才生效。

---

## 2. 一键发布公网助手.exe

**作用**：完成公网发布前的全部准备，生成发布指令。

**背景说明**：公网发布必须通过 WorkBuddy 账号认证接口完成，独立程序无法在无人登录状态下直接发布。因此本助手把能自动化的部分全部做完，最后一步由你在 WorkBuddy 里粘贴发送即可。

**步骤**：
1. 双击打开 → 自动校验发布目录、检查成绩数据。
2. 若检测到已考成绩，会自动做快照备份（存到 `_发布前成绩快照\`），不会删除本机数据。
3. 发布指令已自动复制到剪贴板，同时保存为 `发布指令_可直接使用.txt`。
4. 打开 WorkBuddy，在对话框按 `Ctrl+V` 粘贴并发送 → 完成发布。

**发布后链接**：`https://your-domain.example.com/`（由部署者自行发布后得到）
管理端：同上把 `/?` 换成 `/admin?`，口令与学员密码请自行设置，见 session.example.json 中的 CHANGE_ME。

**提醒**：重新发布会清空云端线上的考试成绩，发布前请确认已做快照。

---

## 表格脱敏说明

场次表和学员名单已做本地脱敏（人名 → 学员001…，地名/单位名 → 占位符），
原始含敏感信息的表格已归档到 `D:\work Buddy\projects\mbo-test\旧系统整理归档_20261125\原始敏感表格\`，未删除、可恢复。

脱敏脚本：`D:\work Buddy\projects\desktop-shell\src\desensitize_excel.py`
用法：`python desensitize_excel.py 输入.xlsx 输出.xlsx`（纯本地、零联网、不回显原文）。
