# 适配器开发说明

本文件是**自足**的适配指南：读完它就能新增一个工具，不需要翻聊天记录。
底座代码位置、启动方式见 `README.md`；这里只讲**差异部分怎么写**——即**生产侧**（把新端接进来）。
**消费侧**（写客户端：网页以外的手机壳、桌面托盘、脚本、别的 AI 写的任何东西）请看 `API.md`：
同一套机制的接口契约、状态机、SSE 协议、错误码与“什么时候该提醒”的判定规则都在那里。

## 你要做什么（最小步骤）

1. 新建 `src/adapters/<your-tool>.ts`，导出一个满足 `Adapter` 接口的对象。
2. 在 `src/registry.ts` 的 `ADAPTERS` 数组里加一行。
3. 给 manifest 提供 `examples`（合法/非法输入样本），跑 `npm test`，契约测试自动校验你的适配器。
4. **不要**改动公共部分（`api/auth/server/runner/store/schema-fields/state`）与 `public/`，
   除非你发现契约本身有缺陷——若改了，必须在 PR/提交说明里写明改了哪个公共文件及原因
   （“复用边界”靠这个纪律维持，不追求形式上的零改动）。

## 适配器契约（src/types.ts 摘要）

```ts
interface Adapter {
  manifest: ToolManifest;   // id / name / description / timeoutMs? / inputSchema / fields / examples?
  run(input, ctx): Promise<
    | { ok: true;  result: JsonValue }          // 成功：结果必须是可 JSON 序列化的（上限 64KB）
    | { ok: false; error: { message, detail?, stage? } }  // 失败：必须留证据
  >;
}

interface AdapterContext {
  taskId: string;
  emit(e: { type: "progress"|"info"|"warning"; message: string; percent?: number }): void;
}
```

### 输入契约：只有一个来源

声明一个 zod object schema，**表单字段由它自动派生**（`fieldsFor`），不要手写 fields 与 schema 两份：

```ts
const inputSchema = z.object({
  text: z.string().min(1).max(20000)
    .describe("要统计的文本")            // description → 字段标签
    .meta({ multiline: true, placeholder: "…" }),  // multiline → 文本域
  sortBy: z.enum(["name", "size"]).default("name").describe("排序方式"), // → 下拉
  limit: z.number().int().min(1).max(500).default(50),                    // → 数字
  verbose: z.boolean().default(false),                                     // → 勾选
});
```

支持的字段类型（刻意有限）：`string`/`number`/`boolean`/`enum`，允许 `optional`/`default`。
**不支持**任意文件上传、嵌套对象、数组输入；也不宣称所有工具都能套同一种表单——
如果目标工具的输入形态不在上表内，请明确不暴露该能力（不要造万能输入框）。

### 进度事件

- `percent`（0–100）只在真的有比例进度时给；否则只发消息（`type: "info"`），前端会退化为“执行中 + 消息流”。
- 消息上限 2000 字符（超出自动截断并标注）；单任务事件上限 200 条（超出自动丢弃并写一条系统标记）。
- **不要**用 `setTimeout` 制造假进度；确定性工具按工作量推进，或干脆只发消息。

### 运行约定

- 你**可以**在 run 里 spawn 子进程、读写文件、发 HTTP——所有目标工具交互方式由你决定。
- 失败一律返回 `{ ok: false, error }` 并带 `message`（必填）；抛异常也会被捕获为 failed，
  记录 `message` + `stage: "adapter.run"` + 堆栈前 4 行。
- **不要**自己改任务状态或写持久层（runner 负责）；只通过 `ctx.emit` 和返回值沟通。
- 结果超过 64KB 会被截断保存（不会假成功）；不可序列化的结果会被标记为失败。
- `timeoutMs` 是**建议等待时间**：超过只会提示“仍未确认结束”，**不会**终止你的执行；
  你应当让真正的长任务在合适时继续完成，用户会看到终态。

### 两个都要读的示例

- `src/adapters/text-stats.ts`：**接口形态 A**——自由多行文本输入、带 percent 的进度、纯计算。
- `src/adapters/dir-listing.ts`：**接口形态 B**——选项类输入（enum/number/optional）、只发消息的进度、
  只读固定白名单目录（**路径类工具必须走这种模式：不接受外部路径输入**）。

## 安全红线（必读）

- 适配器是**受信任的进程内代码**，不是沙箱。不要在适配器里实现“执行任意用户输入的命令”这类能力；
  公共层不提供、也不允许出现任意 Shell 入口。
- 涉及文件系统的工具：只访问工具自己声明的固定目录，输入里不出现路径参数。
- 适配器输出的结果会被当作**文本**展示（绝不作为 HTML）；但也不要在里面放敏感凭据或超大数据。
- 日志策略：底座不记录 token、输入内容与工具输出；你自己的 `console.log` 也请遵守（只记录任务 id 与状态类信息）。

## 契约测试（一致性检查器）

`tests/adapter-contract.test.ts` 会对**每个注册适配器**自动检查：

1. manifest 结构合法：id 唯一且非空、字段与 `fieldsFor(inputSchema)` 派生结果一致、字段类型合法、
   select 字段必须带 options。
2. `examples.valid` 能通过 schema，`examples.invalid` 会被 schema 拒绝。
3. 合法输入运行成功，结果可序列化且在体积上限内。
4. 同一输入**两次运行结果相同**（确定性验证——非确定性工具会被这条挡住，请如实调整或放弃注册）。
5. 非法输入由适配器以 `ok:false` 拒绝且带错误证据（**不能抛异常**）。
6. 事件 `percent` 在 0..100、`type` 合法。

跑 `npm test` 即执行（同时跑全部 HTTP 集成测试）。**新增适配器后测试不过 = 适配未完成。**

## 验证“新增不破坏底座”的方法

- 跑 `npm test`（含公共链路回归；当前测试计数见 `docs/VERIFICATION.md`）。
- 新增工具过程中，统计自己改动的文件：应当只有 `src/adapters/<your-tool>.ts`（新文件）
  与 `src/registry.ts`（加一行）。若你不得不改其他公共文件，说明契约可能有缺陷，
  请把它写进提交说明并同步更新本文件。

## 一个最小模板

```ts
import { z } from "zod";
import type { Adapter, AdapterRunResult } from "../types";
import { fieldsFor } from "../schema-fields";

const inputSchema = z.object({
  name: z.string().min(1).max(100).describe("名称"),
});

async function run(input: unknown): Promise<AdapterRunResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { message: "输入不合法", stage: "input.validate",
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
  }
  // …调用你的工具…
  return { ok: true, result: { greeting: "hi " + parsed.data.name } };
}

export const myToolAdapter: Adapter = {
  manifest: {
    id: "my-tool",
    name: "我的工具",
    description: "一句话说明",
    timeoutMs: 30_000,
    inputSchema,
    fields: fieldsFor(inputSchema),
    examples: { valid: { name: "x" }, invalid: {} },
  },
  run,
};
```

（模板仅示意结构；具体实现必须由你独立完成，不要照抄示例适配器的实现逻辑。）

---

## 第二层：会话型端（session 适配器）

第一层是“一次性任务”（`run`，适合 CLI/批处理类端）。第二层是“会话”（`runTurn`）：
手机里打开一个会话，发消息、看流式输出、回答端的提问、多轮继续。

### 声明能力，不要留空按钮

`manifest.capabilities` 与 `manifest.mode` 是入口渲染的唯一依据，未声明的能力一律不渲染：

```ts
manifest: {
  id: "my-chat", mode: "session",   // task / session / both
  capabilities: { sessions: true, listSessions: true, streaming: true, askUser: false },
  ...
}
```

注册时 `validateManifestFields` 会自检一致性：声明 `sessions` 就不能是 `mode=task`；
声明 `mode != task` 就必须声明 `sessions` 并实现 `runTurn`。不支持的能力直接写 `false`。

### runTurn 契约

```ts
interface SessionAdapter extends Adapter {
  runTurn(req: TurnRequest, ctx: TurnContext): Promise<TurnResult>;
}
interface TurnRequest { sessionId; message; history }   // history = 本会话此前各轮摘要
interface TurnContext {
  turnId: string;
  emit(e: EmitPayload): void;               // 流式输出（与第一层同一事件模型）
  ask(prompt: string, options: string[]): Promise<string>;  // 提问并等待手机回答
  signal: AbortSignal;                      // 服务退出时 abort，立即杀掉你派生的进程
}
```

关键语义（公共层保证，端不用自己实现）：

- 调用 `ctx.ask()` 后轮次进入 `awaiting_answer` 并**持久化问题**；手机回答后迁移到 `answered`，
  `ask` 的 Promise resolve 一次。**同一回答重复提交只 resolve 一次**（幂等由回答通道保证）。
- `answer` 必须是提问时给定的 `options` 之一，否则 API 层 400 `INVALID_ANSWER`。
- 每会话同时至多一个活跃轮次：进行中再发消息返回 409 `SESSION_BUSY`。
- 轮次状态协议（公共页面与 API 统一区分）：
  `streaming`（仍在输出）/ `awaiting_answer`（等待手机回答）/ `answered`（已回答，继续执行）/
  `succeeded` / `failed`（任务失败，带证据）/ `interrupted`（连接/服务中断，结果未知，不重跑不伪称）。
- 服务重启时未终结轮次由 `recoverInterruptedTurns` 标记 `interrupted`，**不会重跑**。
- 关闭时 runner 调用 `dispose()` 广播 abort：**你的 runTurn 必须订阅 `ctx.signal` 并立即杀掉派生的子进程**，
  否则进程退出会被你拽住（stdio 类子进程在父进程退出后通常也会因 stdin EOF 自行终止，但不要依赖这一点）。
- **推流与通知是公共传输层，适配器无感知**：`emit`/状态迁移一旦提交（事务成功）即经
  `TurnBus` 通知 `SessionStreamHub`，按通用事件名（`hello`/`change` + 注释心跳）推给手机，
  字段沿用第一层事件模型——**适配器不需要、也不应该**知道 SSE 的存在或产生任何端私有事件名；
  手机断线以 `sinceSeq` 续传，重放与订阅由 seq 去重。同理，网页通知/标题徽标/振动由公共页面
  按状态机驱动，端不需参与。

### 示例

- `src/adapters/fake-ai.ts` + `fake-ai/agent.js`：纯本地、不联网、无密钥的演示端。
  适配器只做协议翻译（stdio JSON 行 ↔ 底座 ask/emit 协议）；确定性由脚本保证（内容只依赖
  `(消息, 轮序, 回答)`，不含时间戳/随机数）。

### 会话型适配器的安全红线（同第一层，另加）

- **输入仍是 schema 约束的**：消息内容走适配器 `inputSchema`（如 `message: z.string().min(1).max(2000)`），
  不允许把“任意 MCP 工具名 + 任意参数”这类通用执行入口包成会话工具。
- 流式输出内容按**安全 Markdown** 渲染成 DOM（粗体/代码/列表/引用/链接；**HTML 一律当文本**，绝不作为 HTML 注入；见下"前端呈现约定"）。
- 子进程必须在 `ctx.signal` abort 时被杀掉，且不要在结果里放时间戳类非确定性字段
  （会话级“确定性”要求：同一输入加同一回答，结果稳定）。
 
 ---
 
 ## 示例：dsh-agent（接真实公开协议的会话型端）
 
 `src/adapters/dsh-agent.ts` 是一个**真实协议**适配器：按 DeepSeek Harness（DSH，即官方 dsh
 桌面产品内嵌的 dsh web 服务器）**自身公开声明的 `/api` 协议**与之对话。它证明本底座能接入
 一个真实 AI Agent 的公开接口，而通用层无需任何端私有改动。
 
 ### 协议知识的来源（合规边界）
 
- 协议契约只来自 DSH 产品自身的**公开声明文件**（`@deepseek-ai/dsh-host-apiproxy` 的 `lib/types` 声明与各包 README，
  即类型声明而非实现源码）与产品自身可观察的 CLI 帮助。**不读取**任何其他项目源码作为依据。
  **契约稳定性待核实**：包内可见 ≠ 官方对外稳定契约（未见版本化承诺文档），本适配器不把
  它当作稳定 API 对待——已做的只是在**隔离真实实例上实测可调用**（只读级，
  `scripts/verify-dsh-readonly.js`），不宣称“官方支持”。
 - 请求封套：`POST /api/<method>`，body 为 `ClientRequest {type:'client-request', rpcId, method, payload}`，
   响应为 `ServerResponse {type:'server-response', rpcId, result:{ok,value}|{ok:false,error:{code,message,details}}}`。
 - 下行事件走 WebSocket（聚合 mux 流与 host 流）；回答/审批走 `POST /api/respond`（ClientResponse，
   rpcId 原样回显；回执 `{accepted:true}` 或 `{accepted:false, reason}`）。
 - DSH v1 协议**无认证层**，靠 Host/Origin 信任栅栏（回环权威或已声明 trustedHosts）；
   断线恢复的官方模型是“重开事件流 + 重新拉历史”（无 since 回放）。
 
 ### 配置
 
- 服务器地址由环境变量 `DSH_BASE_URL` 提供（**应为回环地址**，如 `http://127.0.0.1:8877`；适配器本身不校验这一点，回环要求由 DSH 侧的 Host/Origin 信任栅栏实际负责）。
  **未配置时适配器以明确错误失败**（`未配置 DSH 服务器地址…`），不静默降级。
- 指向真实（用户正式）DSH：用独立实例而非改 8811 主服务——`scripts/serve-dsh.ps1`
  以 WMI 启动 `dsh-instance/`（独立 config.json + 独立 SQLite，端口 8812），env
  `DSH_BASE_URL=http://127.0.0.1:3080`。8811 不受影响。实例只让适配器在
  runTurn 时读取地址；启动本身不发任何写请求。停止实例：终止其监听进程即可（幂等脚本报 already running）。
  其 `dsh-instance/` 是**本地自建目录**（不在版本库里：其中的 `config.json`、`data/`、日志都被 `.gitignore` 覆盖）。
  首次使用需自己创建 `dsh-instance/config.json`，四个键即可：`token`（访问口令，可与主服务同一口令）、
  `bind`（手机访问需 `"lan"`）、`port`（示例 `8812`）、`dataDir`（如 `"data"`）。缺这个文件时
  `scripts/serve-dsh.ps1` 会直接报错退出。
 
 ### 新增这类端要改的目录（差异隔离的实例）
 
 | 文件 | 作用 |
| --- | --- |
| `src/adapters/dsh-agent.ts` | 适配器本体（协议翻译：DSH 事件 ↔ 底座 emit/ask/终态） |
| `src/registry.ts` | 加一行注册（+import） |
| `fake-dsh/server.js` | 可控的“假协议端”（测试替身，与 `fake-ai/agent.js` 同一角色） |
| `tests/dsh-session.test.ts` | 针对假协议端的会话契约测试（17 项） |
| `scripts/verify-dsh-readonly.js` | 只读连真实 DSH 的验证脚本（隔离 DSH_HOME+cwd+端口） |
| `scripts/serve-dsh.ps1` + `dsh-instance/` | 指向真实 DSH 的独立实例启动器（独立 config/data/端口 8812 + `DSH_BASE_URL`） |
 
 公共层（`session-api/session-runner/store/turn-bus/session-stream/…`）**零改动**——
 这是本底座“通用底子”的正面证据：接入一个全新的真实协议端，核心契约不需要动。
 
 ### 需要安装的东西
 
 - 开发/测试侧：`ws`（devDependency，仅 `fake-dsh/server.js` 做 WebSocket **服务端**用）。
 - 生产侧：**零新增运行时依赖**——适配器用 Node 全局 `WebSocket`（客户端），不引第三方库。
 
 ### 已声明的限制（不造空按钮）
 
1. **提问映射**：DSH 一次可批量提问、可多选、可自由文本；底座的 ask 通道是“单问 + 互斥选项”，
   两者不等价。适配器**只处理“恰好一题、非多选、≥2 选项且选项标签无重复”的提问**；多题批次、
   多选、自由文本、选项不足、重复标签一律**整轮显式失败**并附原始问题证据（对应 stage：
   `dsh.question-batch` / `dsh.question-multiselect` / `dsh.question-unrepresentable` /
   `dsh.question-duplicate-options`）——不悄悄只答首题丢掉其余、不把多选降级成单选、
   不伪造选项、不自动回答。手机侧看到 failed + 缺口说明后可重开轮次处理；
   这条限制同时写进了 manifest 描述（手机 UI 可见）。
2. **审批**：DSH 审批的合法 outcome 恰为 `allowed-once`/`rejected`（协议自身的两个选项，
   非任意二选一）；适配器把它映射为向手机提问 `["允许一次","拒绝"]`，**由手机用户决定，
   适配器绝不代批**，用户的选择被原样回传（`outcome` 字段不做解释、不改写）。
 3. **终态判定**：`turn/end` 的失败判定用 kind 白名单（`error`/`aborted`/`interrupted` ⇒ failed），
    其余视为成功；`stream/error` 直接判失败并带协议错误码。
 4. **断线恢复**：按官方 v1 模型（重拉 `session.history` 尾页按 seq 去重补齐 + 重开事件流），
    重连上限 `MAX_RECONNECTS=6`，超过以 `dsh.reconnect-limit` 失败——不是 since 增量回放
    （DSH v1 协议未提供；本底座 SSE 的 sinceSeq 续传是**底座自己的**传输层能力，两回事）。
 5. **会话标识**：复用底座 sessionId 预分配做 `session.create` 幂等（同 id+cwd 重试返回同一会话）。
 6. **真实会话级未验证**：真实模型对话需要用户凭据/账号，未做自动验证——验证等级标注为
    “模拟=契约全过 / 只读真实=通过 / 真实会话=未验证”（详见 `docs/VERIFICATION.md`）。
 
 ### 测试与验证
 
- `tests/dsh-session.test.ts`：对 `fake-dsh/server.js` 跑 17 项——能力声明、未配置守卫、
  完整会话流（1:1 事件映射 + 流式证据）、重复回答幂等、多轮上下文延续、无提问流、失败流程、
  流错误、审批流程、断线恢复三段、rpc 错误映射、只读探测 + 426/403 栅栏、非法回答 400，
  以及四种不可表示提问形态（多题批次 / 多选 / 自由文本 / 重复选项标签）各测“整轮显式失败
  + 全程无 awaiting_answer + 不向 DSH 提交任何回答”。
- `scripts/verify-dsh-readonly.js`：在完全隔离的环境（临时 DSH_HOME、隔离 cwd、独立端口）启动真实 `dsh web`，只调 `host.describe` 与 `session.list` 两个只读方法（复用适配器同一 rpc 路径）。
   **不创建会话、不发 prompt、不审批、不触碰用户 `~/.dsh`。**
 
 运行：先 `npm run build`（或 `npm test`），再 `node scripts/verify-dsh-readonly.js`
 （可用 `DSH_PORT` / `DSH_BASE` / `DSH_BIN` 覆盖自动发现值）。
 
 ---
 
## 前端呈现约定（适配器作者需要知道的）

会话页把端事件渲染成手机界面，有三点约定与适配器直接相关。这里**不假装零耦合**——
前端确实有一张与端文案相关的表，如实写在这里：

1. **过程事件 vs 回答正文的判定在前端的前缀表里**。会话页默认只呈现"对话本身"：
   过程性事件（连接/提交/启动回执等）被收进每轮的"过程 · N 条"抽屉，判定依据是
   `public/app.js` 的 `PROCESS_INFO_PREFIXES` / `PROCESS_SYSTEM_PREFIXES`（**前缀表**）。
   这是**白名单**：你的端发出的 info 事件若不在表里，会按"安全默认"当**回答正文**显示在
   对话流里——不坏，只是略吵。要让你的端输出更干净，就在表里追加一条前缀（改公共前端
   文件需写明理由并保持 `npm test` 不低于当前基线）。
2. **提醒（声音/振动/标题闪烁/页内提示条）由公共页面与浏览器环境决定，适配器不参与**。
   提问与轮次终态的提示由页面的状态机驱动；明文 HTTP 局域网下**没有系统通知**（需 HTTPS），
   页面会如实降级标注。适配器不需要、也不应该处理提醒——你只管 `emit` 与 `ask`。
3. **事件 `message` 在会话页会被渲染成 DOM（安全 Markdown 子集）**。回答正文与结果卡的
   可读字段（`summary` / `message` / `text`）按 Markdown 渲染：粗体 / 斜体 / 行内代码 /
   围栏代码块 / 无序与有序列表 / 引用 / `http(s)` 链接；**HTML 一律按文本显示**（`<script>`、
   `<img onerror>` 之类的原文绝不会被执行或加载）。适配器可以放心输出 Markdown 让排版
   更好看，但别指望 HTML 标签生效；同样的，结果 JSON 里没有可读字段时会原样展示 JSON。
 ## 来自一次独立接入实测的经验
 
 以下三条来自一次**独立接入实测**：一个全新的 AI 会话仅凭本仓库的干净副本 + 本文件 +
 目标端的 API 文档（不看任何会话历史与既有实现），独立写出了目标端的会话适配器。
 三条都是实测踩到的"文档缺口 → 适配者只能猜"的具体成本，**不夸大为普遍规律**；
 共同的原则只有一条：**目标端的一切"行为"类问题以实测为准，文档缺口写进适配器注释，
 而不是静默选一个假设。**
 
 1. **接口文档与实现冲突时，以实现为准，先实测再适配。**
   这条来自早期实测：当时目标端文档称 `GET /v1/ping` 无需鉴权，实测实现统一要求 Key
   （该文档后来已修正，现在两者一致）。
   原则不变：文档是起点，实测是判据；冲突不靠猜——先发请求验证，再把差异写进适配器注释
   （例如 `// 文档称 X，实测需要 Y`），让后来者不用再猜一遍。
 2. **输入限制的语义（拒绝 vs 截断）必须实测确认，schema 取保守值。**
    目标端文档写"消息 ≤500 字"，实测发现超长不是被拒绝而是**截断后判空**（截断到空串才报错）。
    文档只给数字、不给语义时，不要假定"超限=拒绝"；适配器 `inputSchema` 按文档值取**保守上限**，
    同时在注释里记录实测语义，避免用户以为会被拒绝、实际被静默截断。
 3. **目标端会话标识的生成与生命周期属于必查项，映射方式要如实声明。**
    目标端文档未写会话 id 谁生成（服务端生成？客户端指定？重启后是否失效？），
    适配器只能退回进程内 Map 做映射——这是本可避免的猜测。适配前先确认三点：
    谁生成、能否重用、重启是否失效；映射方式（如"目标端 id 由服务端生成，映射存进程内，
    重启后失效"）写进注释，不当作通用能力宣称。
 
 ---
 
 若你需要一份**可以直接复制给另一个 AI** 的接入提示词（角色、硬约束、发现入口的固定顺序、判定门槛、自测清单与交付格式俱全），见 `docs/ADAPTER-PROMPT.md`：
 把本仓库的一份干净副本和那份提示词一起交给你的 AI，它就会自己找入口、判定、写适配器、自测并交回证据。
