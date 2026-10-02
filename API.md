# API.md — 公共层接口契约（消费方：写客户端看这一页）

这一页是**给客户端作者**看的：网页、手机壳、桌面托盘、脚本、别的 AI 写的任何东西。
**给适配者**（把新端接进来）看的是 [`ADAPTERS.md`](ADAPTERS.md)。两者是同一套机制的生产侧与消费侧。

> **本页怎么来的**：逐行取自源码（`src/api.ts`、`src/session-api.ts`、`src/session-stream.ts`、`src/types.ts`、`src/store.ts`、`src/config.ts`），
> 并对**运行中的实例**实测校对过响应字段与错误码。凡未实测者会显式标注。
> 目标：**照着这一页就能写出客户端，不需要读源码、不需要猜。**

---

## 0. 三十秒版

```
基址：http://<主机>:<端口>            本机示例 http://127.0.0.1:8811
鉴权：Authorization: Bearer <token>   唯一例外：GET /api/health
取数：GET  /api/sessions              列会话（含末轮状态/时间，足以判断"该不该提醒"）
发话：POST /api/sessions/{id}/messages   {"message":"...","idempotencyKey":"<唯一串>"}
收事：GET  /api/sessions/{id}/stream?sinceSeq=N   （SSE；断线带上次 seq 重连）
```

```powershell
$H = @{ Authorization = "Bearer $env:BASE_TOKEN" }
Invoke-RestMethod "http://127.0.0.1:8811/api/sessions?limit=20" -Headers $H | ConvertTo-Json -Depth 4
```

---

## 1. 基础约定

| 项目 | 规定 |
|---|---|
| 传输 | 明文 HTTP（局域网内）；跨网需自备隧道，见 `docs/CLOUDFLARE-TUNNEL.md` |
| 鉴权 | 请求头 `Authorization: Bearer <token>`。**token 绝不出现在 URL、日志、仓库里** |
| 免鉴权端点 | 仅 `GET /api/health`（用来区分"服务不可达"和"未授权"） |
| 请求体上限 | 64 KB（Express JSON 解析上限） |
| 单字段上限 | 见各端点；输入总上限 `maxInputBytes = 16384`，比较的是 `JSON.stringify(...).length` —— **是字符数，不是字节数**（一个中文算 1） |
| 时间格式 | ISO 8601 UTC 字符串，例 `2026-10-02T10:01:07.800Z`；未发生的时刻为 `null` |
| 幂等 | 只有 `POST /api/tasks` 与 `POST /api/sessions/{id}/messages` **必须**带 `idempotencyKey`（1–100 字符）：同键同参 → 重放原结果（200 + `idempotentReplay:true`），同键异参 → 409 `IDEMPOTENCY_CONFLICT`。`POST /api/sessions`（建会话）与 `.../answer`（回答）**不带键**：前者每次调用都新建会话，后者的幂等按"同一回答重复提交"判定 |
| 并发 | 全局 `maxConcurrent = 4`（实例值）；**每个会话同时最多一个活跃轮次** |
| 长任务语义 | 创建即返回，不等执行完毕；**HTTP 超时 ≠ 没创建**（先查列表再决定是否重发） |
| 内容安全 | 所有文本按纯文本处理；客户端渲染一律用 `textContent`（不得拼接 HTML） |
| 稳定性 | 字段只增不减；新增能力走 `capabilities` 声明，客户端遇到未知值应忽略而非崩溃 |

**实例配置**（`config.json`；环境变量优先，前缀 `BASE_`）：`port`(默认 8787)、`bind`(`loopback`/`lan`)、`dataDir`(默认 `data`)、`maxTasks`(500)、`maxConcurrent`(4)、`token`(必填，≥16 字符，用 `npm run token` 生成)。
环境变量：`BASE_PORT` / `BASE_BIND` / `BASE_DATA_DIR` / `BASE_MAX_TASKS` / `BASE_MAX_CONCURRENT` / `BASE_TOKEN`。

---

## 2. 端点总表

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/api/health` | 否 | 存活探测，返回 `{"ok":true}` |
| GET | `/api/tools` | 是 | 工具清单（含形态 `mode` 与能力 `capabilities`） |
| POST | `/api/tasks` | 是 | 提交一次性任务（幂等） |
| GET | `/api/tasks` | 是 | 任务列表（`?limit=`，默认 50，钳制 1–200） |
| GET | `/api/tasks/{id}` | 是 | 任务详情 + 事件（`?sinceSeq=` 增量） |
| POST | `/api/sessions` | 是 | 创建会话 |
| GET | `/api/sessions` | 是 | 会话列表（`?limit=`，默认 20，钳制 1–200） |
| GET | `/api/sessions/{id}` | 是 | 会话详情：全部轮次 + 活跃轮次/末轮及其事件 |
| POST | `/api/sessions/{id}/messages` | 是 | 在会话内发一条消息（创建轮次，幂等） |
| POST | `/api/sessions/{id}/turns/{turnId}/answer` | 是 | 回答端提出的问题（幂等） |
| GET | `/api/sessions/{id}/turns/{turnId}` | 是 | 单轮详情 + 事件（`?sinceSeq=` 增量） |
| GET | `/api/sessions/{id}/stream` | 是 | 会话 SSE 推送（`?sinceSeq=` 断线续传） |

---

## 3. 逐端点

### 3.1 `GET /api/health`
无鉴权。`200 {"ok":true}`。客户端用它判断"连不上"还是"口令错"。

### 3.2 `GET /api/tools`
```jsonc
{ "tools": [ { "id": "dsh-agent", "name": "…", "description": "…",
               "timeoutMs": 600000,                       // 可能不存在
               "fields": [ { "name":"prompt","label":"…","type":"textarea",
                             "required":true,"placeholder":"…",
                             "options":["a","b"], "help":"…" } ], // options/help 可能不存在
               "mode": "session",                          // task | session | both
               "capabilities": { "sessions":true, "listSessions":true,
                                 "streaming":true, "askUser":true } } ] }
```
- `fields` 由适配器的 `inputSchema` 派生，**是渲染表单的唯一依据**（`type` ∈ `text|textarea|number|boolean|select`）。
- `capabilities` 恒为四个布尔（缺省一律 `false`）：**未声明 `sessions` 的工具不得渲染会话入口**；`listSessions=false` 不要渲染历史入口；`askUser=false` 不会出现提问。

### 3.3 `POST /api/tasks`
请求：`{ "toolId": string(1–64), "idempotencyKey": string(1–100), "input": object }`
成功：`201 { "task": TaskRecord }`；幂等重放：`200 { "task": …, "idempotentReplay": true }`
错误：`400 INVALID_INPUT`（字段不合法；**只有 zod 校验失败**才带 `details[]`）、`400 INPUT_TOO_LARGE`、`400 TOOL_MODE_MISMATCH`（会话形态工具走会话入口）、`404 UNKNOWN_TOOL`、`409 IDEMPOTENCY_CONFLICT`；请求体超 64 KB → `413 INVALID_INPUT`（见第 8 节）

### 3.4 `GET /api/tasks` → `{ "tasks": TaskRecord[] }`（`?limit=` 默认 50）

### 3.5 `GET /api/tasks/{id}` → `{ "task": TaskRecord, "events": EventRecord[] }`
`?sinceSeq=N` 只回 `seq > N` 的事件。

### 3.6 `POST /api/sessions`
请求：`{ "toolId": string(1–64) }`
成功：`201 { "session": {id,toolId,createdAt}, "capabilities": {…} }`
错误：`400 INVALID_INPUT`、`409 SESSIONS_NOT_SUPPORTED`（该工具未声明 `sessions`）

### 3.7 `GET /api/sessions` → `{ "sessions": SessionSummary[] }`
```jsonc
{ "id":"…", "toolId":"…", "createdAt":"…",
  "turnCount": 3,                    // 轮次数
  "lastTurnStatus":"succeeded",      // 末轮状态（可能为 null：新会话还没发过消息）
  "lastTurnAt":"2026-10-02T10:01:07.800Z",
  "lastTurnMessage":"…" }            // 末轮的**用户消息**（供列表预览）
```
> **提醒类客户端只需要这一个端点**：`lastTurnStatus` + `lastTurnAt` 足以判定"完成/等待回答"（见第 7 节）。

### 3.8 `GET /api/sessions/{id}` → 详情（断线重连的权威视图）
```jsonc
{ "session": {id,toolId,createdAt},
  "capabilities": {sessions,listSessions,streaming,askUser} | null,   // 端已从注册表移除或不再声明 sessions 时为 null
  "turns": [ TurnRecord… ],           // 按时间正序；终态轮次超过保留上限（500）会被删除，故不保证"全部历史"
  "liveTurn": TurnRecordWithEvents | null,   // 未进终态的那一轮（含 events）
  "lastTurn": TurnRecordWithEvents | null }  // 最新一轮，无论是否终态（含 events）
```
`TurnRecordWithEvents` = `TurnRecord` + `"events": EventRecord[]`。

### 3.9 `POST /api/sessions/{id}/messages`
请求：`{ "message": string(1–2000), "idempotencyKey": string(1–100) }`
成功：`201 { "turn": TurnRecord }`；幂等重放：`200 { …, "idempotentReplay": true }`
错误：`400 INVALID_INPUT`、`400 INPUT_TOO_LARGE`、`404 SESSION_NOT_FOUND`、`409 SESSION_BUSY`（`existingTurnId` 指明占用的那轮）、`409 IDEMPOTENCY_CONFLICT`、`409 SESSIONS_NOT_SUPPORTED`（该端已不支持会话）

### 3.10 `POST /api/sessions/{id}/turns/{turnId}/answer`
请求：`{ "answer": string(1–200) }` —— **必须是 `pendingQuestion.options` 里的一项**
成功：`200 { "turn": TurnRecord }`；同一回答重复提交：`200 { …, "idempotentReplay": true }`
错误：`400 INVALID_INPUT`（answer 缺失 / 非字符串 / 超 200 字符）、`400 INVALID_ANSWER`（不在选项内，回带合法 `options[]`）、
`404 SESSION_NOT_FOUND` / `TURN_NOT_FOUND`（**判空先于请求体校验**：打不存在的轮次得到 404 而非 400）、`409 ANSWER_ALREADY_GIVEN`（已记过别的回答）、`409 TURN_FINISHED`、`409 NOT_AWAITING`

### 3.11 `GET /api/sessions/{id}/turns/{turnId}` → `{ "turn": TurnRecord, "events": EventRecord[] }`

### 3.12 `GET /api/sessions/{id}/stream`（SSE）
响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`。详见第 6 节。

---

## 4. 枚举与数据结构

### 4.1 `TaskRecord`
```jsonc
{ "id":"…", "toolId":"…", "status":"pending|running|succeeded|failed|interrupted",
  "input": {…},                        // 经该工具 inputSchema 解析后的对象（默认值会补齐、未声明字段被剥离），不是提交原文
  "idempotencyKey":"…", "paramsHash":"…",   // paramsHash 为内部指纹，客户端无需使用
  "createdAt":"…", "startedAt":null|"…", "finishedAt":null|"…", "timeoutMarkedAt":null|"…",
  "result": null | any, "error": null | {message,detail?,stage?}, "eventsCapped": false }
```

### 4.2 `TurnRecord`
```jsonc
{ "id":"…", "sessionId":"…",
  "status":"pending|streaming|awaiting_answer|answered|succeeded|failed|interrupted",
  "message":"…",            // 用户这一轮说的话
  "answer": null|"…",       // 用户提交的回答（幂等证据）
  "result": null | any,     // 端的返回值；DSH 轮次里正文在 result.assistantText
  "error": null | {message,detail?,stage?},
  "createdAt":"…", "startedAt":null|"…", "finishedAt":null|"…",
  "pendingQuestion": null | { "prompt":"…", "options":["a","b"], "askedAt":"…" },
  "eventsCapped": false }
```

### 4.3 `EventRecord`
```jsonc
{ "seq": 42,             // 全局单调递增（跨任务/轮次共用一张表），断线续传的唯一游标
  "taskId":"…",          // 任务事件里是任务 id；**轮次事件里是轮次 id**
  "type":"progress|info|warning|system",
  "message":"…", "percent": null|0-100, "createdAt":"…" }
```

### 4.4 能力与形态
| `mode` | 含义 |
|---|---|
| `task` | 一次性任务（表单 → 提交 → 结果） |
| `session` | 只有会话（多轮对话） |
| `both` | 两者皆可 |

| `capabilities` | 为 `true` 时客户端才可以渲染 |
|---|---|
| `sessions` | 创建会话、发消息、拿结果 |
| `listSessions` | 历史会话列表 / 继续旧会话 |
| `streaming` | 持续输出事件（否则只有一次性结果） |
| `askUser` | 执行中会提问并阻塞等待回答（否则不会出现 `awaiting_answer`） |

---

## 5. 轮次状态机（客户端"该干什么"的依据）

```
pending ──▶ streaming ──┬──▶ awaiting_answer ──▶ answered ──┬──▶ awaiting_answer（追问）
                        │                                   ├──▶ succeeded
                        │                                   └──▶ failed
                        ├──▶ succeeded
                        └──▶ failed
```

| 分类 | 状态 | 客户端行为 |
|---|---|---|
| 分类 | 状态 | 客户端行为 |
|---|---|---|
| **活跃（未终结）** | `pending` `streaming` `answered` `awaiting_answer` | 期间再发消息会 409 `SESSION_BUSY`；`awaiting_answer` 另见下一行 |
| **等回答** | `awaiting_answer` | **必须由人点选**（`options` 里的一项）；这是"最该叫醒用户"的时刻 |
| **终态** | `succeeded` `failed` `interrupted` | 展示结果/失败；可以再发下一条消息 |

- `interrupted`：服务重启时未完成的轮次被如实标记为**结果未知**（不重跑、不伪称成功）。
- `awaiting_answer` 除 `answered` 外还有 `failed` 出边：提问期间出错或被关闭信号中止时按失败如实收尾。
- 超时**只打标记不改状态**（任务侧 `timeoutMarkedAt`）：到点不等于失败，不要据此判死。

---

## 6. SSE 协议（`/api/sessions/{id}/stream`）

```
event: hello
data: { …snapshot… }

event: change
data: { …snapshot… }

: ping                     ← 每 20 秒一条注释行心跳（SSE 客户端自动忽略）
```

**快照结构**（`hello` 与 `change` 同构）：
```jsonc
{ "session": {id,toolId,createdAt},
  "liveTurnId": null|"…",     // 未进终态的那一轮
  "lastTurnId": null|"…",
  "turns": [ {id,status,message,answer,result,error:{message,stage}|null,
              createdAt,finishedAt,pendingQuestion:{prompt,options}|null} ],  // 最近 20 轮
  "events": [ {seq,turnId,type,message,percent,createdAt} ] }                 // 仅 seq > 客户端游标
```

规则（照做就正确）：
1. 连接时带 `?sinceSeq=N`（默认 0）：服务端**先注册推送订阅、再回放**库里 `seq > N` 的事件（顺序如此是为不漏掉窗口期内的新变更，靠 `seq` 天然去重）。
2. `change` 帧**不保证与事件一一对应**：状态迁移（成功/失败/拿到回答）本身也会推，此时 `events` 可能为空 —— **必须看 `turns` 里的状态，不能只看 events**。
3. `seq` 全局单调递增，永不回退：把已处理的最大 `seq` 存下来，重连时带上即可天然去重。
4. 心跳是注释行；断开是常态（切后台/锁屏/换网络），**断了就带 `sinceSeq` 重连**。
5. 传输不可靠 ≠ 数据丢失：**权威视图始终是 `GET /api/sessions/{id}`**。
6. 老历史不走 SSE（快照只带最近 20 轮），要看全部走 `GET /api/sessions/{id}`。
7. 响应头 `X-Accel-Buffering: no`（防中间设备缓冲）。

---

## 7. 提醒类客户端：判定规则（照抄即可）

**结论**：只要有一份能定期运行的代码（原生服务/常驻脚本/桌面程序），就能做到"AI 完成或提问时把人叫醒"，**不需要公共层做任何改动**。

```
每 15 秒：GET /api/sessions?limit=20
  首次运行：只记基线（sessionId → lastTurnAt + lastTurnStatus），绝不发通知   ← 否则一开机把历史全播一遍
  之后：对每个会话比较
    lastTurnStatus 变为 succeeded/failed/interrupted  → 通知「AI 完成了 / 出错了」
    lastTurnStatus 变为 awaiting_answer               → 通知「AI 在等你回答」
  去重键：(sessionId, lastTurnAt, lastTurnStatus) —— 同一组只通知一次
  正文：需要 AI 那句话就再取 GET /api/sessions/{id} 的 lastTurn.result
        （DSH 轮次正文字段是 result.assistantText；找不到就退化成「AI 完成了，点开看看」）
```

硬性建议：
- 轮询间隔 **≥ 10 秒**（一次请求就够，别对每个会话各发一次）；单机场景开销可忽略。
- 网络失败/401 **不得误报**为"完成"：只记连接异常。
- 通知里**不要**包含 token 或整段原始 JSON。
- 想要"被划掉也能收"：只能在**客户端侧**做（前台服务/常驻进程/系统级唤醒），公共层不参与。

---

## 8. 错误码全表

响应体**通常**为 `{"error":"<CODE>","message":"<中文说明>"}`，部分带 `details[]` / `options[]` / `existingTaskId` / `existingTurnId`。
两个例外：① 带合法 token 请求**未定义的 `/api/...` 路径**（两个路由器都没匹配）会落到 Express 默认处理器，返回 HTML `Cannot GET /api/...`（无 token 时仍是 401 JSON）；② 请求体超过 64 KB 由 body-parser 直接回 `413`。

| HTTP | error | 何时出现 | 客户端该做什么 |
|---|---|---|---|
| 400 | `INVALID_INPUT` | 请求体字段缺失/超长/非 JSON（zod 校验失败时带 `details[]`，解析层失败时不带） | 按 `details[].path` 修正 |
| 413 | `INVALID_INPUT` | 请求体超过 64 KB（Express JSON 解析上限） | 拆小请求；单条消息自身上限 2000 字符 |
| 400 | `INPUT_TOO_LARGE` | 输入/消息超 `maxInputBytes = 16384`（按 JSON 字符串**字符数**比较，不是字节数） | 截短后重发 |
| 400 | `INVALID_ANSWER` | 回答不在 `options` 内 | 用返回的 `options[]` 重选 |
| 400 | `TOOL_MODE_MISMATCH` | 会话形态工具被当一次性任务提交 | 走 `/session.html` |
| 401 | `UNAUTHORIZED` | 缺/错 token | 重新配对；别在 URL 里带 token |
| 404 | `UNKNOWN_TOOL` / `TASK_NOT_FOUND` / `SESSION_NOT_FOUND` / `TURN_NOT_FOUND` | id 不存在或不属于该会话 | 回列表刷新 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同键异参 | **换新键**重试 |
| 409 | `SESSION_BUSY` | 该会话已有活跃轮次 | 等它结束/回答它的问题（`existingTurnId`） |
| 409 | `ANSWER_ALREADY_GIVEN` | 已记过别的回答 | 显示已记录的回答 |
| 409 | `TURN_FINISHED` / `NOT_AWAITING` | 轮次已结束或不在等回答 | 刷新轮次状态 |
| 409 | `SESSIONS_NOT_SUPPORTED` | 该端未声明/不再支持会话 | 隐藏会话入口 |
| 500 | `INTERNAL` | 服务内部错误 | 稍后重试；必要时看服务端日志 |
| 501 | `STREAM_UNAVAILABLE` | 装配未提供推流中心 | 退化为轮询 `GET /api/sessions/{id}` |

---

## 9. 不变式与坑（读一遍省一天）

1. **`seq` 是全局单序列**（任务与轮次共用），只保证单调递增，**不保证连续**：客户端只能比较大小，不能假设 +1。
2. **每轮/每任务事件上限 200 条**：超出后**新事件被丢弃**（不删旧的），并追加一条 `[系统] 事件数已达上限…`，同时 `eventsCapped=true`。
3. **结果体积上限 64 KB**：超出会被截断保存预览，并写一条系统事件说明（此时 `result` 不是完整数据）。
4. **`limit` 会被钳制到 1–200**（默认：会话 20、任务 50）。
5. **`idempotencyKey` 是"这一次请求"的身份**，不是"这个会话"的身份：每次新消息都要**新的键**；只有重试**同一次**请求才复用。
6. **每会话同时只能有一个活跃轮次**：想连发两条 → 第二条 409 `SESSION_BUSY`。
7. **`awaiting_answer` 占全局并发名额**：等回答的轮次仍算"在跑"，堆积会挤占 `maxConcurrent`。
8. **`events[].taskId` 在轮次事件里装的是轮次 id**（字段名历史遗留）；SSE 快照里已重命名为 `turnId`。
9. **HTTP 超时 ≠ 未创建**：客户端必须按幂等键重试或先查列表，避免重复提交。
10. **令牌只有一条**（固定 token，非多用户）：任何拿到它的人都能用，别放进前端代码、截图、日志或 URL。
11. **选项文本 > 200 字符 = 该轮永远无法回答（已确认的契约缺口）**：提问侧对 `options` 文本长度无校验，而回答侧硬上限 200 字符且必须回选项原文；客户端遇到这种选项只能如实报"无法回答"。
12. **轮次不是永久保留**：终态轮次（连同其事件）超过保留上限 500 时会被物理删除；要长期留档请自行导出。

---

## 10. 最小客户端示例

<details>
<summary>PowerShell：列出会话并打印"需要提醒"的</summary>

```powershell
$base  = "http://127.0.0.1:8811"
$token = $env:BASE_TOKEN            # 不要写死在脚本里
$h     = @{ Authorization = "Bearer $token" }
$sessions = (Invoke-RestMethod "$base/api/sessions?limit=20" -Headers $h).sessions
foreach ($s in $sessions) {
  $need = $s.lastTurnStatus -in @("succeeded","failed","interrupted","awaiting_answer")
  if ($need) {
    Write-Output ("[{0}] {1}  {2}" -f $s.lastTurnStatus, $s.id.Substring(0,8), $s.lastTurnMessage)
  }
}
```
</details>

<details>
<summary>伪代码：一个提醒客户端的完整骨架</summary>

```text
state = 读本地持久化的 { sessionId → (lastTurnAt, lastTurnStatus, 是否已通知) }
loop 每 15 秒:
  list = GET /api/sessions?limit=20                      // 401 → 标记"未配对"，通知用户去配对
  for s in list.sessions:
      key = (s.id, s.lastTurnAt, s.lastTurnStatus)
      if 首次运行: state[s.id] = key; continue            // 建基线，不通知
      if key == state[s.id]: continue                     // 已通知过，跳过
      if s.lastTurnStatus in [succeeded, failed, interrupted]:
          body = 取 GET /api/sessions/{s.id} → lastTurn.result 里的 assistantText/summary/text
                 （取不到就用「AI 完成了，点开看看」）
          发系统通知(标题=s.lastTurnMessage 前 20 字, 正文=body 前 120 字, 点击→打开该会话)
      if s.lastTurnStatus == awaiting_answer:
          发系统通知(标题=同上, 正文=「AI 在等你回答」, 点击→打开该会话并高亮选项)
      state[s.id] = key
```
</details>

---

## 11. 这份契约管不着的事（说清楚，省得白找）

| 做不到 | 为什么 | 谁来做 |
|---|---|---|
| 浏览器在后台/锁屏时收到系统通知 | 明文 HTTP 下浏览器不授予通知权限；后台页面会被系统冻结 | 客户端侧：原生壳 + 系统通知 |
| 手机 App 被划掉后仍收到 | 安卓限制，属客户端持久化策略 | 客户端侧：前台服务/常驻进程（尽力而为） |
| 跨网（不在同一 Wi-Fi）访问 | 需公网域名与隧道 | 见 `docs/CLOUDFLARE-TUNNEL.md` |
| 多用户隔离 / 权限分级 | 本底座定位是"单人单机 + 局域网" | 不在当前设计目标内 |
| 取消正在跑的轮次 | 公共协议未定义取消语义（宁缺勿伪） | 尚未实现 |
