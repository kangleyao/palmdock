# 掌坞（palmdock）

> **通用手机/电脑 AI 交互底座**：公共层——手机页面 + 连接 + 会话/任务机制 + 鉴权 + 契约——是成品；接新端只需在 `src/adapters/` 加**一个适配器**。
>
> ⚠️ **这是演示项目，不是可部署产品**：单人单机、明文局域网 HTTP、单一固定 token、无多用户/权限分级、无公网推送；**不要直接暴露到公网**。
>
> **30 秒上手**：`npm install --ignore-scripts` → `npm run token` → 配置 `config.json` 的 `bind=lan` → `npm start`
>
> **文档地图**：`ADAPTERS.md`（接新端 / 生产侧）· `API.md`（写客户端 / 消费侧契约）· `docs/DEMO.md`（演示与验证证据）
>
> ![会话列表](docs/screenshots/01-sessions.png) ![对话](docs/screenshots/02-chat.png) ![深色模式](docs/screenshots/03-dark.png)

供 AI 按需适配的**通用基础环境**：公共手机网页、通信、鉴权、任务状态与结果展示由底座提供；
目标工具的差异集中在 `src/adapters/` 下的适配器。新增受支持工具 = 写一个适配器 + 在注册表加一行，
不必重写公共页面、通信与鉴权。

> 本仓库是**底座**，不是完整远程 Coding Agent 产品。当前用两个接口不同的**普通确定性工具**做阶段性验证，
> 不代表已完成真实 Agent 接入或最终 Demo。

## 技术选型（本轮实际选用）

- Node.js（当前机器 v24.20，选当前受支持版本，不锁死具体次版本号）+ TypeScript（tsc 编译，CommonJS 输出）
- Express 5（HTTP API + 静态页面）、zod 4（输入契约与校验）
- better-sqlite3 13（持久化；WAL + synchronous=FULL，单进程事务串行写、原子提交）
- 前端：五个静态页（会话主页 / 工具 / 表单 / 任务详情 / 入口跳转桩）+ 原生 JS；**会话层用 SSE**（fetch 流式读取 + 通用事件名 hello/change + 注释心跳，无 WebSocket），**任务层保留 HTTP 轮询**；回答正文按**安全 Markdown 渲染成 DOM**（HTML 一律当文本）；提醒用 WebAudio/振动/标题/页内提示条通道，系统通知需 HTTPS（不支持时如实降级）；不依赖仅 HTTPS 可用的浏览器 API
- 无动态代码执行、无自动插件扫描：适配器**显式注册**

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/types.ts` | 任务状态机、适配器契约、事件、限制的共享类型 |
| `src/config.ts` | 配置加载（环境变量 > config.json > 默认值） |
| `src/store.ts` | SQLite 持久层：任务、事件、状态迁移强制、上限裁剪 |
| `src/state.ts` | 合法状态迁移表 |
| `src/runner.ts` | 进程内调度执行、超时只提示、结果截断、重启恢复 |
| `src/registry.ts` | 适配器显式注册表 + 清单自检 |
| `src/schema-fields.ts` | zod schema → 前端表单字段定义（单一来源派生） |
| `src/api.ts` | HTTP API（见下） |
| `src/auth.ts` | 固定 token 鉴权（sha256 + timingSafeEqual） |
| `src/server.ts` | Express 装配（安全头、CSP、静态页面） |
| `src/index.ts` | 入口：配置 → 持久层 → 恢复 → 启动 → 优雅关闭 |
| `src/adapters/text-stats.ts` | 工具 A：文本统计（多行文本输入 + percent 进度） |
| `src/adapters/dir-listing.ts` | 工具 B：目录清单（选项输入 + 消息流进度 + 只读白名单目录） |
| `src/adapters/inkstone-mcp.ts` | 工具 C：书生·端砚 MCP stdio 工具清单（外部程序，只读元数据级别） |
| `src/adapters/inkstone-mcp-stdio.ts` | 两个 inkstone 适配器共用的 MCP stdio 会话（路径/JSON-RPC/子进程管控） |
| `src/adapters/inkstone-biorxiv-categories.ts` | 工具 D：端砚 MCP 工具调用——bioRxiv 类目（固定 server+tool，空参数只读查询） |
| `src/adapters/fake-ai.ts` | 工具 E（会话形态）：假 AI 演示端（spawn 本地脚本，协议翻译） |
| `src/adapters/dsh-agent.ts` | 工具 F（会话形态）：**真实公开协议**适配器——按 DeepSeek Harness 自身声明的 `/api` 协议接入真实 dsh web（需环境变量 `DSH_BASE_URL`，详见 `ADAPTERS.md`） |
| `src/session-runner.ts` | 会话轮次运行器（第二层）：ask 挂起/恢复、AbortSignal dispose、中断恢复 |
| `src/session-api.ts` | 会话 HTTP API：创建会话 / 发消息（幂等）/ 回答（幂等）/ 重连视图 / SSE 流 |
| `src/turn-bus.ts` | 轮次变更总线：持久层事务提交后通知订阅者（推流触发点） |
| `src/session-stream.ts` | 会话 SSE 推流中心：hello/change 快照 + sinceSeq 续传 + 心跳 + 关闭清理 |
| `src/session-state.ts` | 轮次状态机（streaming / awaiting_answer / answered / 终态） |
| `src/result-guard.ts` | 结果序列化与体积截断（任务与轮次共用同一规则） |
| `fake-ai/agent.js` | 演示助手（fake-ai）本地脚本（纯本地、无网络、无密钥、行为固定） |
| `fake-dsh/server.js` | dsh-agent 的可控“假协议端”测试替身（文档化 DSH `/api` 协议的最小实现，仅供测试） |
| `public/session.html` | 会话主页（应用入口）：未授权配对卡；列表视图（会话列表 + 新建会话）+ 聊天详情（消息输入 + SSE 流式事件 + 二选一问答 + 通知行 + 历史轮次） |
| `public/tools.html` | 工具页（二级）：一次性任务端分区，按能力展示入口 |
| `public/index.html` | 入口跳转桩：统一跳转到 `/session.html` |


| `src/tools/gentoken.ts` | 生成 token 写入 config.json（`npm run token`） |
| `public/` | 公共手机网页（会话主页 / 工具 / 表单 / 任务详情 / 入口跳转桩） |
| `tests/` | 全部测试（见下） |
| `docs/CLOUDFLARE-TUNNEL.md` | 跨网接入说明（不实际配置，仅文档） |
| `android-shell/` | 示例 Android 客户端（**可选、非框架部分**：WebView + 前台服务 + 原生系统通知；由另一个 AI 独立写出、公共层零改动；**真机未验证**，可整目录删除） |

## HTTP API

所有 `/api/*`（除 `/api/health`）都需要 `Authorization: Bearer <token>`，token 不出现在 URL 或日志。

| 方法 路径 | 说明 |
|---|---|
| `GET  /api/health` | 不需 token，仅返回 `{ok:true}`，用来区分“可达但未授权”与“不可达” |
| `GET  /api/tools` | 已注册工具清单（含表单字段定义） |
| `POST /api/tasks` | 提交任务：`{toolId, idempotencyKey, input}`，**创建即返回 taskId，不等执行** |
| `GET  /api/tasks?limit=` | 最近任务列表 |
| `GET  /api/tasks/:id?sinceSeq=` | 任务详情 + 事件（`sinceSeq` 支持增量轮询） |

### 会话 API（第二层）：同一鉴权与事件模型

| 方法 路径 | 说明 |
|---|---|
| `POST /api/sessions` | `{toolId}` 创建会话（仅对声明了会话能力的工具，否则 409） |
| `GET  /api/sessions?limit=` | 会话列表（轮次数 / 末轮状态） |
| `GET  /api/sessions/:id` | 会话详情：历史轮次 + 活跃轮次全部事件（**断线重连视图**） |
| `POST /api/sessions/:id/messages` | 发送消息 `{message, idempotencyKey}`，每会话同时只允许一个活跃轮次 |
| `POST /api/sessions/:id/turns/:turnId/answer` | 回答 `{answer}`，**幂等**：同一回答重复提交不会二次继续执行 |
| `GET  /api/sessions/:id/turns/:turnId?sinceSeq=` | 轮次详情 + 事件增量 |
| `GET  /api/sessions/:id/stream?sinceSeq=` | 会话 SSE 流：`hello`（快照）→ `change`（增量事件 + 轮次状态）+ 注释心跳；断线以 sinceSeq 续传，不丢不重 |

轮次状态协议：`streaming`（仍在输出）/ `awaiting_answer`（等待手机回答）/ `answered`（已回答继续执行）/
`succeeded` / `failed`（失败带证据）/ `interrupted`（服务中断，结果未知，不重跑）。
适配器能力声明（`capabilities`）决定公共页面渲染哪些入口——不支持的能力明确标记，不留空按钮。
手机页面到达“使用水平”的三件公共能力（与端无关）：
- **会话列表**：`session.html` 无 id 时的列表视图（会话主页；未授权先显示配对卡）（末轮状态徽标 + 消息预览 + 点击继续）。
- **SSE 实时推流**：页面打开会话即连接 `/stream`（带 token 的 fetch 流），事件与状态变更即时到达；
  连接断开自动回退 1.5s 轮询并以 sinceSeq 重连续传（传输不可靠 ≠ 状态丢失：持久层是权威视图）。
- **网页提醒**：会话页提供四条通道——声音（WebAudio 合成，提问上行两声、完成/失败下行两声，无音频文件）、
  振动、标题徽标（`【待回答】`闪烁）、页内"收到提问"提示条（点击滚到提问卡）；前台与后台标签页均触发，
  后台标签页用静音保活通道维持事件到达；"关闭提醒"总闸关后声音与振动零残留。**系统通知需 HTTPS**
  （明文 HTTP 局域网下不可用，页内如实标注"需要 HTTPS——跨网隧道那一轮才解锁"）。完全关闭浏览器
  仍想收到通知需要系统级推送服务（公网暴露），**安全边界禁止**，属已知缺口（见验证状态）。
- **本地缓存秒开**：会话内容按会话 id 缓存在浏览器 localStorage（`agb_sess_<id>`，带 schema 版本号，
  不含 token）；再次打开先用缓存**立刻渲染**、顶部短暂标注"更新中…"，再向服务器刷新；
  断网时如实显示"离线，显示的是上次内容"；提问卡缓存为"待回答"时，刷新确认后立即更正。
演示助手（fake-ai）固定行为：收消息 → 3 段输出 → 二选一提问 → 回答后 2 段收尾 → 结果；
消息为“失败”或“fail”时确定性地失败（输出一段后 fatal，失败轮次带 `error` 证据、无结果）。

### 任务状态与边界语义（这是本底座的核心约定）

```
pending → running → succeeded
                    └→ failed
pending|running → interrupted   （仅服务重启时，结果未知，不重跑、不伪称已停止）
running 不因超时变状态           （超时只打 timeoutMarkedAt + 系统事件提示“仍未确认结束”）
```

- **幂等键**：客户端生成 `idempotencyKey`。同 key 同参数 → 返回已存在任务（200，不重复执行）；
  同 key 异参数 → **409 IDEMPOTENCY_CONFLICT**（附 existingTaskId）。网络失败重试**复用同一键**。
- **提交请求超时 ≠ 任务未创建**：提交是“创建即返回”，手机端可用同一幂等键重查/重提。
- **断网 ≠ 任务失败**：前端轮询失败只显示连接横幅，不清空已刷新出的状态与事件。
- **服务重启**：未终结（pending/running）任务标记为 `interrupted` 并写系统事件说明结果未知；
  适配器随服务进程运行，若派生独立子进程，该子进程可能仍在运行——底座不重跑也不声称其已停止。
- **失败必须有证据**：`failed` 任务带 `error.{message, detail?, stage?}`，适配器抛异常时记录堆栈前 4 行。

## 启动与测试

```bash
npm install --ignore-scripts  # 安装依赖。带 lock 时 npm 会对 better-sqlite3 触发 node-gyp rebuild（包内无 install 脚本、npm 的 binding.gyp 兜底），本机无 VS C++ 工具链会失败；该依赖集无需要本地编译的包，忽略脚本后使用 tarball 自带的预编译二进制（机制未查明，见 docs/DEMO.md「从零安装与测试」）
npm run token          # 生成随机 token 写入 config.json（不在控制台打印）
npm run build          # tsc 编译到 dist/
npm start              # 前台启动服务（依赖当前终端，终端关闭进程即被树终止）
npm run serve          # Windows：以独立进程常驻启动（WMI 创建，不依赖当前会话）
 npm test               # 编译 + 跑全部测试（137 项，见下）
```

### Windows 独立常驻启动（`npm run serve`）

`npm start` 前台运行时，进程属于启动它的命令会话；该会话结束（终端关闭、
Agent 命令超时）会把整棵进程树一并终止——表现正是“短暂监听后退出、无异常栈、无日志”，
这不是应用崩溃。`npm run serve`（= `scripts/serve.ps1`）用 `Win32_Process.Create`（WMI）
创建进程，它不属于任何命令会话树，因此跨会话常驻。

- **幂等**：端口监听者已是本服务（命令行含 `dist/src/index.js` 且 `/api/health` 200）时直接报
  “已在运行”，不做二次启动。
- **日志**：stdout/stderr 全量重定向到项目根 `server.log`；进程内未捕获异常/未处理拒绝会先写明
  日志再优雅退出（`src/index.ts` 的 `uncaughtException`/`unhandledRejection`/exit 处理器）。
  被外部强杀（任务管理器/树终止）时进程无法自我记录——那属于启动机制问题，重跑 `npm run serve` 即可。
- **停止**：`Stop-Process -Id <listener pid>`（pid 见启动输出或 `netstat -ano | findstr :8811`）。
- 注意：`.ps1` 含中文注释，以 **UTF-8 with BOM** 保存；Windows PowerShell 5.1 对无 BOM 的 UTF-8
  会按本地 ANSI 解码，乱码字节会破坏 `param()` 默认值（`$Log` 变空 → 重定向目标拼出空文件名）。

环境变量（优先级高于 config.json）：`BASE_TOKEN`、`BASE_PORT`、`BASE_BIND`（`loopback`|`lan`）、
`BASE_DATA_DIR`、`BASE_MAX_TASKS`、`BASE_MAX_CONCURRENT`。`config.example.json` 是配置模板。

`inkstone-mcp` 适配器依赖环境变量 `INKSTONE_HOME`（书生·端砚安装目录，须自行设置，例：`set INKSTONE_HOME=D:\inkstone`），
它调用目标自带的封闭 Python 执行其 stdio MCP 服务器，只做工具清单级别的只读查询（不调用任何工具）。
`inkstone-biorxiv-categories` 共用同一入口与 `INKSTONE_HOME`，固定调用 mcp_biorxiv 的
`get_categories`（空参数、readOnlyHint=true、调用前三重校验），属于真实只读工具调用。

## 默认网络暴露与手机访问

- **默认 `bind=loopback`**（127.0.0.1）= 最小暴露；此时手机访问不到。
- 同 Wi-Fi 测试：`config.json` 设 `"bind": "lan"` → 监听 0.0.0.0，手机打开 `http://电脑局域网IP:8811`，
  未授权先显示配对卡，填访问口令（仅存本机浏览器 localStorage，经请求头发送）后进入会话主页。
- 跨网（出门在外）：见 `docs/CLOUDFLARE-TUNNEL.md`（固定域名隧道；**本文档仅为配置说明，未实际配置与实测**）。

**明文 HTTP 的限制（如实说明）**：局域网模式为明文 HTTP，token 与数据在链路上明文传输；
页面不使用仅 HTTPS 可用的浏览器 API，功能不受影响；跨网建议走带 TLS 的隧道。

## 限制与安全边界

- 适配器是**受信任的进程内代码**（不是沙箱；测试通过 ≠ 隔离）。公共层不提供任意 Shell 输入入口；
  新适配器须由人审阅后放入 `src/adapters/` 并显式注册。底座不在运行中加载未经确认的代码。
- 目录类示例工具只允许读固定白名单 `data/listing-root`，不接受任意路径输入。
- 输入上限 16KB、结果上限 64KB（超限截断并存证）、单任务事件上限 200 条、终态记录上限 `maxTasks`（默认 500），
  并发上限默认 4，请求体上限 64KB。
- token 不硬编码、不进 URL/日志/仓库（config.json 已 .gitignore）；工具输出与端回答正文按**安全 Markdown**
  渲染成 DOM（HTML 一律当文本，绝不直接作为 HTML 注入）。
- 暂不做：暂停/取消轮次、PWA、多用户/细粒度权限、插件市场、任务层 SSE（会话层已具备）；Android 原生通知壳（见下“未验证”）。
- 单实例写同一数据库（多进程写同一库不受支持）。

## 验证状态（如实）
 **已测试**（`npm test`，137 项全过：117 通过 / 20 跳过 / 0 失败，真实回环 HTTP + 真实 SQLite；第一层任务 + 第二层会话 + 真实协议适配器）：

未授权被拒（含无 token/错 token/格式错）、health 免鉴权、工具清单与字段、合法与非法输入、任务成功与适配器异常
（抛异常、ok:false、结果不可序列化）、幂等重放与参数冲突 409、状态与结果查询、事件顺序与 sinceSeq 增量、
percent 合法性、结果截断存证、安全响应头、静态页面可访问、前端无 innerHTML/eval 注入、记录上限裁剪、
事件上限与消息截断、重启 interrupted 语义、超时只提示不失败、串行 FIFO、适配器契约（结构/确定性/确定性复跑）。
第二层（会话）已测：能力声明与门控、假 AI 完整流程（流式→提问→回答→结果）、重复回答幂等、
断线后状态恢复、确定性（同一输入加同一回答逐行一致）、非法回答 400、单会话单活轮次 409、
消息幂等、会话上下文延续（turnIndex 递增）、服务退出时子进程 dispose。
第二层使用水平已测：会话列表（末轮状态与消息预览）、假 AI 失败流程（failed + error 证据 + 列表一致）、
SSE 真实流（hello→流式→等待→回答→终态；seq 单调无重复；断线 sinceSeq 续传不丢不重；
SSE 下重复回答幂等；失败推流；流鉴权 401/404；服务关闭经 hub.closeAll 结束所有流）。
dsh-agent（真实公开协议适配器）已测：对可控假协议端 17 项——能力声明、未配置守卫、完整会话流
（1:1 事件映射 + 流式证据）、重复回答幂等、多轮上下文延续、无提问流、失败流程、流错误、审批流程、
断线恢复三段、rpc 错误映射、只读探测 + 426/403 信任栅栏、非法回答 400、四种不可表示提问形态
（多题/多选/自由文本/重复选项）整轮显式失败（不降级、不自动回答、不向 DSH 提交任何回答）。
跳过的 20 项为依赖外部环境（端砚安装/外部脚本）的契约 example 测试，不注入外部依赖（如实跳过）。


另有真实服务 live 验证：`npm run serve` 常驻启动后，对 8811 端到端跑通第二层全流程 29 项检查
（健康→列表→创建会话→SSE 推送→消息→两个选项→回答→succeeded+结果→重复回答幂等不重放→
断线 sinceSeq 续传→第二轮 turnIndex=1→失败流程→列表状态与预览→页面安全），且服务跨多个命令会话存活。

  另有今夜界面九轮的**验收方独立复测**（Edge headless 390×844，回环测试实例；真实 DSH 会话只读查看、
 8900 临时实例造数）：① 会话页降噪与呈现——AI 气泡 13→1、过程事件进"过程 · N 条"抽屉（`aria-expanded`
 可展开收起）、回答正文按安全 Markdown 渲染（`<strong>`/列表/代码块；`<script>` 注入直测当文本显示、
 `javascript:` 链接降级、https 链接带 noopener）、结果卡可读正文 + 可展开"查看原始结果"；② 提醒四通道
 （WebAudio 声音、振动、标题闪烁、页内提示条；前台与真 hidden 后台标签页均触发；关闭后零残留；
 明文 HTTP 下无系统通知，如实标注）；③ 本地缓存秒开（`agb_sess_<id>` + schema 版本 + 无 token；
 打开先渲染缓存、顶部短暂"更新中…"、断网显示"离线，显示的是上次内容"、提问卡缓存态被真实刷新
 立即更正）；④ 历史事件丢失缺陷（缓存/竞态导致的早期事件被丢弃）已修——渲染去重由"跨来源共享单调水位"改为"已渲染集合"（key=`(turnId|taskId)|seq`）、SSE 游标独立（只由流数据推进，REST 与缓存回放不推进）、缓存写入改为渲染合并集（无损）；实测（真实 DSH 会话只读）：无缓存与连续 3 次热缓存加载结果完全一致（抽屉 3/3/5 行、AI 气泡 2、0 重复、0 JS 报错）、旧缺陷形态缓存被服务器数据自愈补齐（缓存回写为 13 条）、离线仍显示缓存内容 + 如实横幅；新增 `tests/frontend-merge.test.ts` 5 项；列表行等高 65/66px、多页回归与页面横向溢出 0、全程 0 JS 报错。真机表现见"未验证"。
 
  另有今夜界面打磨七轮（第 8–14 轮）的**验收方独立复测**（同一套 390×844 无头浏览器 + 真人点击流程）：
  ⑤ **观感对齐 iOS（第 8 轮）**——分层由"中灰描边"改为"底色差"（浅底 `#f2f2f7`/白卡 + 发丝线 `#eceef1`；
  深底 `#000`/卡 `#1c1c1e`，卡片外阴影清零）、文字灰阶 2→3 级（`#1c1c1e`/`#7c7c82`/`#aeaeb2`）、主色 `#007aff`
  （用户气泡 `#0a6fe0`：`#0a84ff` 白字实测仅 3.65:1 不达标，如实换用并标注）、圆角与字阶统一、按压 `scale(.97)`、
  进场与抽屉动效、骨架屏替代长驻 spinner、聊天页 30px 圆形头像（纯 DOM，无图片/base64）；
  ⑥ **基本功修复（第 9 轮）**——修掉两处**无效 CSS**（`font: 15px/1.4 inherit` 简写里 `inherit` 非法，整条被浏览器丢弃，
  打字框与 64 位口令框实际落到 `13.33px`），改为显式 `font-family`/`font-size`/`line-height`（16px 是 iOS 聚焦不缩放门槛）；
  会话行标题 `15px/400`→`17px/600`（行高仍 66px，未撑高列表）；⑦ **文案人话化（第 10 轮）**——7 处开发者腔清零
  （`1..2000` → "请写 1 到 2000 个字"、`幂等键…` → "同一个任务请求被用在了不同的内容上"、任务页裸 uuid 收进折叠），全仓关键词 0 命中；
  ⑧ **P0 热修（第 11 轮）**——真人点击发现**会话列表整行点不动**（第 8 轮整块改写吞掉了 `row.href` 赋值），已恢复并加 1 条防回归测试；
  同时对 R7 副本做**多重集逐行比对**（37 条消失行：33 条有意、4 条意外，已全部修复或如实说明）；
  ⑨ **收尾（第 12 轮）**——补回结果卡"结果"标签、合并重复声明、折叠按钮与对话框按钮 25→44px、打字指示器恢复 3 点，
  加 2 条守卫测试；实测全页低于 44px 的可点元素 = 0。
  ⑩ **结果卡重复正文修复（第 13 轮，用户实测发现）**——真实 DSH 轮次把正文放在 `result.assistantText`，而结果卡既不认这个字段、又把整段 `result` 以**可见的原始 JSON** 直出 → 同一段回答被渲染两次（AI 气泡 + JSON，两处哈希逐字节相同）。已改为：原始 JSON 一律默认收起（点「查看原始结果」展开）、`readableResultText` 识别 `assistantText`（连事件已丢的历史轮次也能读到正文）、同一轮正文已在气泡出现时结果卡只留一行状态；实测 8812 三条会话（干净配置）：页面可见 `pre.code` 数 = 0、回答只出现一次、点开/收起往返正常、fake-ai 摘要路径未受影响；`npm test` 131 项 / 111 通过 / 0 失败。
  ⑪ **井号标题解析（第 14 轮，用户实测发现）**——`renderMarkdownInto` 原来**没有 ATX 标题分支**，真实回答里的 `##`/`###` 被当普通段落、井号原样留着（真实数据 7 轮里 2 轮命中、共 5 行，含 `###`）。已加：1–6 级标题 → `h1`–`h6`（`md-h1…md-h6` 类，最多 3 个空格缩进、井号后必须有空白、行尾闭合井号剥掉），标题内仍走 inline 解析；**保守不误判**（`#标签`、单独 `#`、`#######` 一律当普通文字），**围栏代码里的 `#` 永不变标题**；样式 20/700、17/600、15/600 层级分明、首末标题去边距、`overflow-wrap: anywhere` 不横向溢出。实测（验收方独立探针 + 真实会话只读）：样例标题元素 4 个（含引用内标题）、字面井号 **23→12**（剩下的全是"不该解析"的例子与围栏内容）、围栏内容原样保留；真实会话 `110cf4e0` 标题元素 **5 = 库里 5 行**、气泡内字面井号行 **0**（改前 2）；第 12/13 轮行为未回退（折叠按钮 44px、原始 JSON 默认收起、状态行在）。
  另有**真实鼠标点击 + 键盘输入**的全流程验收（干净浏览器配置、手敲 64 位口令、点击造会话 → 发消息 → 点选项 → 看结果 → 刷新 ×3 → 切主题 → 工具页表单 → 退回列表，15+ 步全通过）：
  唯一发现的 P0 即第 11 轮的会话行不可点（已修）。**每轮验收方式**：源码计数断言 + 无头浏览器实测 + 真人点击三步，
  且 `npm test` 退出码必须为 0（有 1 轮测试块缺闭合 `}` 致编译失败，已修并复核）。
 
 另有真实 DSH 只读验证（`node scripts/verify-dsh-readonly.js`，先 `npm run build`）：在完全隔离的环境
 （临时 `DSH_HOME`、隔离 cwd、独立端口 8899）启动真实 `dsh web`，经适配器同一 rpc 路径只调
`host.describe` 与 `session.list` 两个只读方法——5 项检查全过（安装发现、CLI 定位、端口监听、
describe 成功、list 返回 items=0）。全程不创建会话、不发 prompt、不审批、不触碰用户 `~/.dsh`。

**未验证**：真实手机浏览器访问**已验证过一次完整流程**（用户本人在昨夜用真机经 8812 + 正式 DSH 跑通：
发消息 → 出现结构化提问 → 手机点选 → 完成 → 刷新后内容仍在；当时为旧版界面）；**今夜改造后的界面**
（会话页降噪 / 提醒四通道 / 安全 Markdown / 秒开缓存）尚未真机复验；**真机提醒的实际效果**——手机是否
真的振动、后台标签页是否真的出声（无头浏览器的"后台"与 Android 标签页冻结机制不完全等价，静音保活通道的实际效果需真机复验）；
系统通知（明文 HTTP 下不可用，需 HTTPS；iOS Safari 无 Notification API；Android Chrome 通常可用但未实测）；
跨网隧道（文档未配置、未实测）；高并发/大数据量性能；waiting 期间占用调度槽未做超时回收；
"完全关闭浏览器仍收通知"需要推送服务（公网暴露），被禁止，属已知缺口。
**dsh-agent 真实会话级**：已由用户本人在真实 DSH 上**跑通过一轮完整问答**（真机经 8812：发消息 →
结构化提问 → 点选 → 完成；服务端该会话 3 轮记录、末轮 succeeded）；**仍未验证**的是真实 DSH 上的
多题/多选/自由文本/审批等复杂形态与长对话（协议层处理已由契约测试覆盖）。验证等级：
“模拟=契约全过（17 项）/ 只读真实=通过（5 项）/ 真实会话=一次单轮问答跑通，复杂形态未验证”。
**关于 Android 通知壳**：提醒的**送达**属于**客户端层**——「锁屏也收 / App 被划掉也收」只能由原生壳（前台服务 + 系统通知）、
常驻进程或桌面托盘实现，这不是框架职责；公共层只提供机制与事实，且已足够（`API.md` 第 7 节给出「什么时候该提醒」的判定规则，
第 11 节写明哪些事必须由客户端自己承担）。本仓库**附带一个示例客户端** `android-shell/`（Android：WebView + 前台服务 + 系统
通知），由另一个 AI 在**不改公共层一个字节**的前提下独立写出（公共层 47 文件 SHA256 0 差异），并有可安装 APK（构建可复现）。
它**不是框架的一部分**：删掉整个目录不影响底座任何功能。**真机未验证**（本机无 Android 设备）——只验证了构建、签名、清单属性、
只读接口冒烟与逻辑复核。边界不变：明文 HTTP + 同一 Wi-Fi、无公网推送；「被划掉也收」需电池白名单，属尽力而为。

## 给下一个接手者（Atria 或人）

新增工具请读 `ADAPTERS.md`——它包含完整契约、字段定义方式、两种接口形态的示例与契约测试用法，
不依赖本 README 之外的聊天上下文。

写客户端（网页以外的手机壳 / 桌面托盘 / 脚本）请读 `API.md`——逐端点字段、轮次状态机、SSE 协议、错误码全表、
以及“什么时候该提醒”的判定规则，照着写即可，不需要读源码。
