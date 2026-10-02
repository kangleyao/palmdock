# 目标端接入工作流

本文件说明如何把**一个新的目标端**接入本底座：从发现到验证的完整流程，以及每一步必须留下的证据。
读完它，一个不了解本项目历史的 AI 会话也能独立对任意目标端执行接入。
模板内的"端砚实例"是 2026-09-30 的一次真实执行记录，可作为对照。

## 0. 前置纪律与安全红线（先读）

- **只允许**：读取目标安装目录中的说明、清单、配置、帮助输出；调用目标**自己暴露**的 CLI / MCP / 本地 API。
- **禁止**：拆解、反编译、解包 app.asar 一类私有包体；挂钩/注入/调试器附加；绕过校验或授权；提取密钥；修改目标安装文件。
- 不执行会修改用户数据、上传数据或产生费用的调用。**首选只读元数据/帮助级别的真实调用**。
- 若必须启动目标本体，只做短时、可退出的接口探测，结束就关闭**自己启动的进程**；绝不关闭用户原本在运行的进程。
- 不改系统防火墙、不暴露公网、不改 DNS/Cloudflare。
- 接口不足、权限不足或结果不稳定 → **明确输出"当前不能接入"并说明缺什么**，不要猜测补齐。

## 1. 发现（逐项找证据，留下路径/命令/结果）

对每一项，留下：证据文件/命令、输出摘要、结论（可用/不适用）。

1. **插件/扩展**：安装目录里是否有 plugins / extensions / addons 目录与加载约定。
   - 端砚实例：`<端砚安装目录>\resources` 下无 plugins/extensions；Electron 资源为 app.asar + unpacked。**结论：无插件入口。**
2. **命令行**：主程序与运行时组件带 `--help` / `-h` 的输出（短时调用，看完即退）。
   - 端砚实例：`resources\runtime\orbit-agentd.exe -build-info` →
     `{"role":"agent_runtime","binary_version":"0.2.5",...}`（exit 0）。
     `--help` 显示其参数是内部运行时旗标（agent-secret-fd、broker-socket、state-root、lifeline-fd），是私有组件接线，不是公开工具 CLI。**结论：CLI 仅元数据级，不作接入入口。**
3. **MCP**：目标是否带 MCP 服务器（run_server.py / mcp SDK / catalog.json / server 清单）。
   - 端砚实例：`resources\science-mcp\catalog.json`（23 个 server、共 247 个工具、全部 `readOnlyHint=true`）、
     `run_server.py`（stdio 启动器）、`invoke_server.py`（一次性 JSON 隔离桥，需要 mcp SDK）。
     解释器在 `resources\science-pack\python\python.exe`（密封 Python 3.12.13，含 mcp==1.29.0，见
     `resources\science-pack\requirements.lock`）。**结论：正规 MCP stdio 入口可用。**
4. **本地 HTTP/API**：目标进程是否监听 TCP（`Get-NetTCPConnection -State Listen` 按进程筛选）。
   - 端砚实例：端砚主进程与其子进程**零 TCP 监听**；manifest 中 broker-socket 为"私有本地端点"描述符，非公开 API。**结论：无本地 HTTP API。**
5. **官方自动化接口**：manifest/配置中是否有对外自动化约定。
   - 端砚实例：`resources\runtime\manifest.json`只声明 agent/broker/executor 三个内部构件与哈希，无对外接口契约。**结论：无。**

## 2. 理解（对选定入口实测，回答六个问题）

以最小真实调用回答（**每个问题都要有实测证据，不许从文档推断**）：

- 输入：报文格式、字段、必填项
- 输出：成功/失败的报文形态、体积量级
- 状态：是否长连接、是否需要 initialize、有无会话
- 错误：非法输入、进程崩溃、超时的表现
- 可重复调用：同一请求两次结果是否一致（确定性）
- 计时：冷启动与稳态耗时

端砚实例（MCP JSON-RPC over stdio，记录于 2026-09-30）：

| 检查 | 命令/方式 | 结果 |
|---|---|---|
| 输入 | 逐行 JSON-RPC：`initialize` → `notifications/initialized` → `tools/list` | initialize 返回 serverInfo（如 `pubmed-mcp-server v1.29.0`） |
| 输出 | tools/list 响应 | 工具数组：name/description/inputSchema/annotations.readOnlyHint |
| 状态 | server 常驻 stdio | 一次 initialize 后可多次 tools/list |
| 可重复 | tools/list 连调两次 | 结果完全一致 |
| 计时 | 精确等待响应 | initialize 1.32s；tools/list 约 0.05s |
| 错误 | 用错 server 名/缺少解释器依赖 | run_server.py 打印 usage 退出 2；缺 mcp 依赖时 python 抛 ImportError（系统 Python 复现过，密封 Python 正常） |

## 3. 选择（优先级与判定）

优先级：**插件/扩展 > 命令行 > MCP > 本地 API**。只选"正规、文档/清单可见、只读或低风险"的入口。
找不到任何合规入口时，输出：`当前不能接入` + 缺失条件清单（例如"需要官方 CLI 但未随安装提供"）。

端砚实例结论：**选定 science-mcp 的 stdio MCP**（目标自带密封解释器、清单可见、工具全只读、无网络副作用，停在 tools/list 元数据级别调用）。
插件无、CLI 仅内部、无 HTTP、broker/executor 为私有内部组件不碰。

## 4. 适配（映射到本底座的适配器契约）

映射规则：

- 目标端是"一次性请求 → 一次性结果"→ 落到 `run(input) → {ok:true, result}`，本身就是有界任务。
- 目标端有会话/长连接 → 只把**一次完整交互的元数据**包成有界任务（如 list 一次工具清单），不要把长会话塞进 run。
- 目标端可变的工具调用 → 本底座第一版**不接入执行**，只暴露只读元数据（除非工具清单明确标注只读且无外部副作用）。
- 外部依赖（解释器路径、安装路径）用环境变量注入，默认值写在本适配器内并在文档登记，不写死到公共配置。

端砚实例产物：`src/adapters/inkstone-mcp.ts`
- 输入：`server`（枚举，快照自 catalog.json 的 23 个 server 名）
- 行为：用环境变量 `INKSTONE_HOME`（须自行设置）指向的端砚目录下的密封 Python 启动 `run_server.py <server>`，
  完成 initialize/initialized/tools/list，返回 `{server, serverInfo, tools:[{name,readOnly,description}]}`
- 停留在**元数据级别**：不调用任何科研工具（工具描述可能带外部检索副作用，一概不执行）
- 子进程全程管控：完成或超时即 kill；`-I -B` 避免生成 pyc 污染目标安装目录
- 不提供契约 `examples`（依赖外部安装环境，自动测试不注入外部依赖）；其联通性通过真实提交验证

## 5. 验证（真实调用 + 回归测试）

1. 工作流前两步的全部"实测证据"必须在本仓库外可复核（命令记入本文档或适配器注释）。
2. 重新构建底座、重启服务，**真实提交一次**新适配器的任务并走到终态（succeeded），人工/脚本核对结果内容。
3. 跑 `npm test` 全套回归（公共链路不得退化）。
4. 若新增适配器破坏了"新增不必动公共部分"的边界，如实记录改了哪个公共文件、原因（本文档"已知教训"登记）。

端砚实例验证记录：真实提交 `inkstone-mcp` succeeded，返回 8 个工具元数据（记录于 2026-09-30）。

## 6. 失败处理

出现以下任一情况立即停止，不要"猜着补"：

- 目标没有正规入口（私有协议、加壳、未文档化）→ 输出"当前不能接入"。
- 入口能起但行为不稳定（随机失败、结果不确定、依赖网络鉴权无法本地复现）→ 停止，记录现象。
- 需要秘钥/凭据才能调用 → 停止，说明缺什么。
- 调用会改动用户数据或产费用 → 撤回到只读元数据级别；若连只读级别都没有，判定不能接入。

## 已知教训（执行中真实踩到，供后来人参考）

1. **目标运行时依赖**：端砚 MCP 服务器依赖其自带密封 Python（含 mcp SDK）。用系统 Python 直接跑会 ImportError。
   教训：发现阶段就要找到"目标自己用哪个解释器"，而不是用自己的。
2. **进程树清理**：子进程必须显式 kill 并 wait；stdio 管道在服务器未退出前不会 EOF，读响应要按 id 匹配而非等 EOF。
3. **公共测试硬编码清单**：本仓库 tests/api.test.ts 曾硬编码工具清单，新增适配器必须改它（已改为子集断言）。
   教训：把"新增工具不动公共文件"的边界写进测试时，测试本身不能反噬这个边界。

---

## 第二次执行记录（2026-09-30，从"列工具"推进到"调用一个只读工具"）

**筛选**：catalog.json 中 23 个服务器 / 247 个工具全部为在线科学数据库（无离线计算工具）。
逐个检查了全部 11 个无参数工具的 inputSchema 与描述后，按"零参数、readOnlyHint=true、无账号、无写入、无费用"筛选。

- 用户首选 `mcp_biomart / list_marts`：协议层成功，但**外部 Ensembl 服务返回 HTTP 403**（负载为错误页文本），
  外网依赖不可用且不稳定 → 按失败处理规则放弃。
- `mcp_biorxiv / get_categories`、`mcp_regulation / jaspar_list_taxa`、`mcp_expression / gtex_dataset_info`
  均真实探测一次：成功、只读、空 schema。选定 **get_categories**（最快 167ms、最小 2.1KB、纯公开学科分类元数据）。

**接入产物**：`src/adapters/inkstone-biorxiv-categories.ts`（另抽 `src/adapters/inkstone-mcp-stdio.ts` 为共享会话）
- server/tool 为代码常量（不接受任意工具名）；调用参数固定为空对象（不接受任意参数）；
  输入只有一个可选的 `maxCategories`（1..30），不构成通用执行入口；
- 调用前在同一会话内校验：工具存在 / readOnlyHint=true / 无必填参数，任一不满足拒绝调用（防上游版本漂移）；
- 上游返回非约定负载（错误页等）按 ok:false 上报，不猜测补齐；
- 保留只读工具清单能力（inkstone-mcp 未被替代）。

**验证**：真实 HTTP 任务一次 succeeded；结果含 27 条公开类目（结构 `{name, api_format, description?}`），
无敏感内容；测试 47 项（37 通过 / 10 跳过 / 0 失败）。

**遗留风险**：该调用为对 bioRxiv 公共 API 的出站只读 HTTPS 请求（本目录所有工具均如此，无离线选项）；
不上传任何用户数据（参数为空），但严格意义上的"零外网"在本目录不可实现——已如实上报。


---

## 第三次执行记录（2026-09-30，第二层：会话型端 + 本地假 AI 验证）

**背景修正**：前两轮把“适配端”做成了“一次性工具调用”（只到 tools/list 或单次只读调用），
与“AI 连手机、弹性适配每个端”的初心不一致。随后在保留第一层的基础上补了第二层。

**新增公共能力**（可被任意会话型端复用，非 fake-ai 专属）：
- 适配器声明能力：`manifest.mode`（task/session/both）+ `manifest.capabilities`
  （sessions/listSessions/streaming/askUser），不支持的能力明确标记，页面不渲染空按钮；
  注册表启动自检声明一致性。
- 会话/轮次持久化与状态机：`streaming` / `awaiting_answer` / `answered` / `succeeded` /
  `failed` / `interrupted`；事件、幂等键、上限、截断与任务完全同规则。
- 提问-回答协议：`ctx.ask(prompt, options)` 挂起轮次并持久化问题；手机回答经
  `POST /api/sessions/:id/turns/:turnId/answer` 幂等恢复（同一回答重复提交只恢复一次）。
- 断线重连：`GET /api/sessions/:id` 返回历史轮次 + 活跃轮次全部事件 + 当前等待状态。
- 关闭语义：`TurnContext.signal`（AbortSignal）+ `SessionRunner.dispose()`；服务退出广播 abort，
  端必须杀掉派生子进程；重启时未终结轮次标记 interrupted（不重跑、不伪称）。

**假 AI 如何工作**：`fake-ai/agent.js` 是纯本地 Node 脚本（不联网、无密钥、不读写用户文件），
stdio 逐行 JSON 协议：start → 3 段输出 → ask（恰好两个选项）→ 收 answer → 2 段收尾 → done。
输出内容只是 `(消息, 轮序, 回答)` 的固定函数（无时间戳/随机数），同一输入加同一回答逐行一致。
适配器 `src/adapters/fake-ai.ts` 只做协议翻译与子进程管控，不做业务逻辑。

**验证**：64 项测试，49 通过 / 15 跳过 / 0 失败；真实 HTTP 走完整流程成功；
线上服务（http://192.168.x.x:8811）会话页可访问。

**未验证/风险**：真实手机浏览器未做实机测试（仅 HTTP 层 + 静态安全检查；**注**：此为本次记录当时的状态，
其后用户已真机经局域网 + 正式 DSH 跑通过一次完整流程，当前状态见 `docs/VERIFICATION.md`）；未接任何真实 AI 后端；
轮次等待人工回答期间占用一个调度槽（maxConcurrent 内），长会话并发未压测。

**未通过 SSH/隧道做任何配置，未修改防火墙，未碰端砚安装文件。**


## 第四次执行记录（2026-09-30，第二层使用水平推进：会话列表 + SSE 推流 + 网页通知 + 失败流程）

**目标**：第二层从“协议跑通”推进到“接近既有生产系统的使用水平”，架构保持通用、不读不抄既有系统。

**新增公共能力**（均与具体端无关）：
- 会话列表视图：`GET /api/sessions` 增 `lastTurnMessage`（末轮消息预览）；`public/session.html`
  无 `?id` 时显示已有会话列表 + 新建会话表单（仅列出声明会话能力的端）；首页加“进行中的会话”区块。
- 会话 SSE 推流（`GET /api/sessions/:id/stream?sinceSeq=`）：持久层事务提交后经 `TurnBus`
  通知 `SessionStreamHub`，按通用事件名推送——`hello`（连接快照）/ `change`（增量事件 + 最近轮次快照）
  + 注释行心跳；字段沿用第一层事件模型（seq/type/message/percent/createdAt），
  **不含任何具体端的方法名、事件名或私有字段**。重连以 `sinceSeq` 续传，seq 天然去重（不丢不重）。
- 手机通知能力：会话页先探测 `Notification` API（支持/已授权/被拒/不支持四种状态显式呈现），
  提问与轮次终态时发系统通知（tag 去重，重连重放不重复弹窗）+ 标题徽标 + 振动；
  不支持通知的浏览器退化为页内视图。**未做 Android APK**：见下“差距”。
- 假 AI 失败指令：消息为“失败/fail”（忽略大小写首尾空格）时输出一段后以 fatal 结束，
  让失败流程可确定复现与测试；失败轮次带 `error.{message,stage}` 证据，`result` 为 null。

**改动文件**：新增 `src/turn-bus.ts`、`src/session-stream.ts`、`tests/session-stream.test.ts`；
改 `src/store.ts`（onTurnChange 钩子、listSessions 末轮消息、listSessionEventsAfter）、
`src/session-api.ts`（stream 路由 + 列表字段）、`src/server.ts`/`src/index.ts`/`tests/helpers.ts`
（总线与推流中心装配、关闭时 closeAll）、`fake-ai/agent.js`（失败指令）、
`public/session.html`（列表视图 + 通知行）、`public/app.js`（会话列表、SSE 客户端、通知模块、首页会话区块）、
`public/index.html`、`public/style.css`、`tests/sessions.test.ts`（失败流程测试）、README、本文件。

**验证**：`npm test` 71 项，56 通过 / 15 跳过（端砚环境不可用）/ 0 失败。
新增真实测试：SSE 完整流程（hello→流式→等待→回答→终态，seq 单调无重复）、
断线重连续传（重放历史零事件、后续事件只到一次）、SSE 下重复回答幂等、失败流程推流、
SSE 鉴权（401/404）、服务关闭经 hub.closeAll 结束所有流（不拽住进程退出）、
假 AI 失败流程（failed + error 证据 + 列表视图一致性）。

**未验证/与既有生产系统使用水平的差距**：
- 仍无真实手机浏览器实机测试（SSE fetch 流、Notification 权限、振动均未在真机验证）；
- 明文 HTTP（局域网）下网页通知在不同手机浏览器上可用性未知（iOS Safari 无 Notification API，
  需 HTTPS+PWA 路径；本环境无 Android 构建工具链与设备，APK 未做）；
  “完全关闭浏览器仍能收到提问/完成”需要推送服务（公网暴露）——被安全边界禁止，属已知缺口。
- 未接任何真实 AI 后端；会话并发 awaiting 占调度槽依旧未回收。
