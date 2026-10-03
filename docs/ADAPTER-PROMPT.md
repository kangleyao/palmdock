# 接入提示词

## 1. 给使用者的说明（先用 30 秒看完）

- 把本仓库的一份**干净副本**和本文件一起交给你的 AI（任何会读写代码的 coding agent 都行），再告诉它目标端的名字或安装位置，它就会自己找入口、判定、写适配器、自测并交回证据。
- 你不用教它架构。产出固定为：1 个新文件 `src/adapters/<your-tool>.ts` + `src/registry.ts` 里 2 行注册；页面与通信层一行不改。
- 若端暂时不可接，你收到的会是「当前不能接入 + 缺什么」的清单，而不是一份猜出来的代码。
- 契约细节让它读 `ADAPTERS.md`；完整流程与安全纪律见 `docs/ADAPTATION-WORKFLOW.md`。本文件是这两份的**提示词形态**：直接复制粘贴，不用再整理。

## 2. 提示词正文

> 从下面这行到「3. 命令行型端的套路」之前，原样复制给你的 AI；把 `<目标端>` 换成你自己的端名即可（后面两节是参考资料，一并发给它更好）。

---

你是**接入工程师**。你的任务是把 `<目标端>` 接进这个底座。

**产出物固定为两样**：

1. 一个新文件 `src/adapters/<your-tool>.ts`（适配器本体）；
2. `src/registry.ts` 里 2 行注册（1 行 import + 1 行数组项）。

页面、API、会话与传输等公共层**一行不改**。消费侧长什么样与你无关（那是 `API.md` 的事），你只对生产侧负责，契约细节以 `ADAPTERS.md` 为准。

### 2.1 硬约束

- **只使用目标端自己公开提供的入口**：官方 CLI、官方公开包、产品自带的 `--help`、产品自己生成的协议类型（如 `generate-ts` 一类命令）。
- 不反编译、不解包私有包体（app.asar 一类）、不附加调试器、不提取密钥、不修改目标安装文件。
- **公共层零改动**：`public/` 下全部文件，以及 `api` / `auth` / `server` / `runner` / `store` / `schema-fields` / `state` / `session-*` / `turn-bus` / `config` / `types` / `result-guard` 一律不碰。
- **不新增依赖**：适配器本体只用 Node 内置能力（`child_process`、全局 `WebSocket` 等）。若为测试造一个可控的假端而引入 devDependency，必须逐字说明理由。
- **不留后台常驻进程**：你派生的子进程在结束时立即杀死——**会话型**适配器靠订阅 `ctx.signal`（abort 即杀）；**任务型**适配器没有 abort 通道，必须自己设超时并在 `finally` 里显式杀掉整个进程树，把这一处置写进适配器注释。不要给系统留下守护进程。
- 只做只读或低风险级别的真实调用；不执行会改用户数据、上传数据或产生费用的调用。
- **不确定就明确输出「当前不能接入 + 缺什么」**，不猜测补齐，不伪造选项，不替用户代答、代登录、代审批。

### 2.2 发现入口的固定顺序（按命中率排序）

逐项试，每项留下证据（命令 + 输出摘要 + 结论「可用 / 不适用」）：

1. **安装目录**：看顶层 `resources\`，找 `*.asar.unpacked\**\cli`、`bin`、`vendor`——很多桌面产品把 CLI 打包在这里，其 `package.json` 的 `bin` 字段会直接点名。
2. **数据目录**：`~/.<产品>/` 下有没有 `cli/`、`agents/`、`sessions/`、`rollout/`、`db`——有这些目录就说明该产品跑过 CLI。
3. **入口 shim**：`~/.<产品>/entry/*.cmd`、`%APPDATA%/npm`、`~/.local/bin`、`~/.bun/bin`——注意：shim 存在 ≠ 可用，它可能只是个转发器。
4. **公开包注册表**：`npm view <候选包名>` 或 registry 搜索——最省事，也最正当。
5. **Node 包直接试跑**：`node <bundle> --help`——零成本，`--help` 不消耗额度、不写数据。
6. **端口观察**：按 pid 查 `netstat -ano`，**只做观察**；看到端口 ≠ 有接口。

**必查项（拿到结构化输出后立刻做）**：先取一份**真实输出样例**，确认「哪个字段才是答案」再写映射——非法取值探测法只能拿到协议的**取值**，拿不到字段语义。实例见 4.1：`codex exec --json` 的答案在 `item.completed` 事件里 `item.type === "agent_message"` 的 `item.text`，而不是事件流里第一个看着像正文的字段。

### 2.3 判定门槛（四条同时满足才接）

1. **入口是公开的**：官方包 / 官方文档 / `--help` 里写着（哪怕是随产品打包的运行时，只要产品自己提供 `--help`）。
2. **能无头跑**：不需要人在图形界面点击。
3. **输出可解析**：json / stream-json / JSONL / 明确的文本协议。
4. **能控权限**：有只读档位或工具开关——否则不适合放进「手机遥控」的场景。

**缺任何一条 → 直接输出「当前不能接入 + 差什么」，不猜、不补、不降级硬接。** 纯 GUI 且无公开入口的端，判定为不可接——这是产品方的缺口，不是底座的缺陷。

### 2.4 适配步骤（映射到 `ADAPTERS.md` 的契约）

- **任务型还是会话型**：端是「一次性请求 → 一次性结果」→ 落 `run(input) → { ok: true, result }`；端有多轮交互 → 落 `runTurn`（`mode: "session"`）；只有你真把一个有界请求（如「列一次会话清单」）包成了 `run`，才写 `both`。
- **能力声明**：`manifest.mode` + `manifest.capabilities`（`sessions` / `listSessions` / `streaming` / `askUser`）是入口渲染的**唯一依据**；不支持的老实写 `false`，不留空按钮。
- **输入**：一个 zod object schema，字段与上限按目标端**实测**取值填；表单由它自动派生，不手写 schema 与 fields 两份。文件路径类输入一律不接受外部路径参数。**端的输入上限没实测到时**，schema 取保守值，并在适配器注释里写明「该上限未实测」——不要把保守值当成实测值写进 manifest 描述。
- **流式事件**：`ctx.emit({ type: "progress" | "info" | "warning", message, percent? })`；只在真有比例进度时给 `percent`，否则只发消息；不要用 `setTimeout` 制造假进度。
- **提问-回答**：`ctx.ask(prompt, options)` 是「单问 + 互斥选项」。端一次问多题 / 多选 / 自由文本 / 选项不足 / 选项标签重复 → **整轮显式失败并附原始问题证据**，不偷答、不降级成单选、不伪造选项、不自动回答。
- **错误映射**：失败一律返回 `{ ok: false, error: { message, detail?, stage? } }`，不要抛异常；把端的原始错误码 / 状态码放进 `detail`。
- **子进程**：分形态处置——**会话型**必须订阅 `ctx.signal`，abort 时立即杀死派生的子进程；**任务型没有 abort 通道**（`AdapterContext` 只有 `{ taskId, emit }`），必须自己设超时并在 `finally` 里显式杀掉整个进程树，杀进程策略写进适配器注释。两种形态都按协议 id 匹配响应，不要干等 EOF。
- **确定性**：同一输入加同一回答，结果逐字稳定——不要在输出里放时间戳或随机数。**AI 型端例外**：模型输出本质不确定，「同一输入两次结果相同」对 AI 型端不适用；如实声明这一点、并且**不提供 `examples` 即为合规**（契约测试的运行类检查在无 examples 时自动跳过，与仓库既有先例一致），不要把它当异常处理。

### 2.5 自测清单

先跑**公共部分**（两种形态都要）：

- [ ] 第一条顺序：`npm run build` 必须在 `npm run token` **之前**——token 脚本指向 `dist/`，顺序颠倒会直接报 `MODULE_NOT_FOUND`。
- [ ] `npm test` 全套通过（含契约测试：manifest 结构一致、examples 合法 / 非法、合法输入成功且可序列化、同一输入两次结果相同、非法输入以 `ok:false` 拒绝而不抛异常、事件合法——**这些运行类检查仅在你提供了 `examples` 时才执行**，AI 型端不提供 examples 时自动跳过，见 2.4 确定性条目）。
- [ ] **跑通失败路径**：终态为 `failed` 且带 `error.{ message, stage }` 证据。命令行型 AI 端往往**无法靠输入构造失败**（实测：任何非空 prompt、甚至纯空白都成功返回）；此时允许用**环境注入**制造失败路径（例如把适配器用来定位可执行文件的环境变量指向另一个程序），并在交付说明里如实标注注入方式。
- [ ] **公共层零改动验收**：若副本含 `.git`，用 `git status --porcelain` 核对；若副本由 `git archive` 生成（**不含 `.git`**），该命令不可用，改用等价做法——在主仓库执行 `git ls-tree -r HEAD` 取基线清单，再对副本文件逐个 `git hash-object` 比对，或直接对公共层逐文件算 SHA256 与基线比。
- [ ] 只改了允许改的文件：新增 1 个适配器文件 + `src/registry.ts` 的 2 行。
- [ ] 若提供 `examples`：确认合法 sample 在**目标端不在线**时也能跑通契约测试；做不到就按仓库既有先例不提供 examples，并在注释里登记理由。

**任务型（`mode: "task"`）另加**：

- [ ] 对**真实端**跑通一次端到端：提交任务 → 走到 `succeeded`，结果字段与端真实输出一致（哪个字段是答案，见 2.2 必查项）。
- [ ] **幂等 / 并发冲突**：同键同参重放返回 200 + `idempotencyReplay: true`；同键异参返回 409 `IDEMPOTENCY_CONFLICT`（任务型的并发冲突是这一条，**不是**会话型的 `SESSION_BUSY`，两者语义不同）。
- [ ] **超时与进程树清理**：自身超时触发后，在 `finally` 里杀掉整个进程树，不留残留进程（任务型没有 `ctx.signal`）。

**会话型（`mode: "session"`）另加**：

- [ ] 对**真实端**跑通一次端到端：发消息 → `streaming` →（若有提问）`awaiting_answer` → `answered` → `succeeded`。
- [ ] **幂等重放**：同一回答重复提交，确认返回 200 + `idempotencyReplay: true`，不二次执行。
- [ ] **并发 409**：活跃轮次内再发消息，确认返回 409 `SESSION_BUSY`。
- [ ] **abort 订阅**：服务退出时派生子进程被立即杀死，不拽住进程退出。

### 2.6 交付格式

交回三段，一段都不能少：

1. **改了哪几个文件**：清单 + 每个文件的改动摘要（应为 1 个新文件 + `registry.ts` 2 行；若改了别的，逐字说明原因）。
2. **端到端证据**：关键命令与输出摘要（建会话 / 提交任务 → 各状态迁移 → 终态），失败路径、幂等与并发冲突证据（**按形态**：任务型为 `IDEMPOTENCY_CONFLICT`，会话型为 `SESSION_BUSY`）各一份；失败路径若用了环境注入，注明注入方式。
3. **哪些没有验证**（必须如实列出，不许留白也不许写成「已完成」）：
   - 按三档标注验证等级：模拟 = 契约测试全过 / 只读真实 = 通过 / 真实会话 = 已验证或未验证；
   - 逐条列出未做的事，例如「真实账号未登录，未验证真实模型对话」「未在真实手机浏览器测试」「多会话并发未压测」「端输入上限未实测，schema 取了保守值」；
   - 凡是你自己选了一个文档没写明的语义（会话映射存在哪里、端上限低于底座上限时如何处理等），写进适配器注释与交付说明，不要默不作声。

### 2.7 常见坑

以下条目来自对四个真实命令行型端的实测与真实独立接入实践，写成「遇到 X 时这样做」：

**发现与探测阶段**

1. **shim 存在 ≠ 可用**：`~/.<产品>/entry/*.cmd` 可能只是个转发器，跑一下看输出再下结论。
2. **有端口 ≠ 有接口**：`netstat` 看到的监听端口，若没有公开声明就不要接——观察可以，接入不行。
3. **安装脚本可能被策略拦截**：`npm` 的 postinstall 可能默认不执行，包装了一半；验证可执行文件真实存在且 `--help` 能跑。
4. **输出格式可以「故意给错」来探测**：传一个非法取值（如 `-o bogus`），程序会把合法取值列出来——零成本拿到协议**取值**（但拿不到字段语义，见 2.2 必查项）。
5. **产品自述比猜测可靠**：`doctor`、`product.json`、`generate-ts` 这类自述命令先看，它们直接告诉你这个端是什么。

**运行环境与权限**

6. **运行时依赖缺失但可降级**：端默认想找的环境（如 Git Bash）找不到时往往自动回退（改用 PowerShell）；用环境变量指定或跳过检查即可，不要因此判死。
7. **默认权限档位可能是「全禁 / 全放」**：先看端配置的默认值；`bypass` 类开关**绝不能当默认**。
8. **登录是人的动作**：未登录时端的所有调用直接失败——输出「缺一次人工授权」，不代登录、不绕过。

**适配实现阶段**

9. **examples 与外部依赖冲突**：契约测试会真实运行 `examples.valid`——若它依赖目标端在线，端不在线时测试就红。让 examples 在无外部服务时也能跑；做不到就按既有先例不提供 examples 并登记理由（AI 型端本来就是这条路径，见 2.4）。
10. **会话映射存哪里、丢了怎么办**：端不说明它的会话 id 由谁生成时，退回进程内 Map 做映射是可接受的做法，但把「重启后失效」如实写进注释与 manifest 描述；映射丢失时新建端侧会话并发一条 warning，不要假装延续旧会话。
11. **端的上限低于底座上限（2000 字）**：`inputSchema` 里按端实际上限取**保守值**，让底座先拒绝；不要原样转发后让端静默截断（端的真实语义可能是「截断后判空」而非「拒绝」）。上限**没实测到**时同样取保守值，并在注释里写明「该上限未实测」。
12. **端把重放当 409**：底座对同一回答的重复提交只会让适配器收到一次；若端本身把重放当错误，按错误映射如实转成 `ok:false` 证据，不要重试到看似成功。
13. **端的错误体不带 `message`**：构造 `error.message` 时自己兜底（错误码 / HTTP 状态码 / 原始片段），原始证据放 `detail`。
14. **文档与实现冲突时，以实现为准**：先发一次真实请求验证，再把差异写进适配器注释（如「文档称 X，实测需要 Y」），不要照着文档猜。
15. **子命令的 argv 与顶层参数不通用**：把顶层选项混写进子命令 argv 是常见错误（实例见 4.1 的 argv 限制）；不确定时对**目标子命令**单独跑一次 `--help`，以它的输出为准。

## 3. 命令行型端的套路

这一节是本文件最实用的部分。四个真实产品（独立官方 CLI / 应用内打包 CLI / 应用内 Node 包 / 公开 npm 包——四种来源）的参数几乎一模一样：**命令行型端有一套稳定套路**。你的适配器只要覆盖这套套路，就能覆盖绝大多数同类产品。

| 能力 | 收敛写法 | 在契约里对应什么 |
|---|---|---|
| 无头单次 | `-p` / `--print` / `--prompt` | 一次性请求 → 一次性结果，天然映射到任务型 `run` |
| 结构化输出 | `--output-format text\|json\|stream-json`（或 `--json` 出 JSONL） | `json` 映射终态结果；`stream-json` / JSONL 映射流式 `emit`；**答案在哪个字段必须取真实样例确认** |
| 会话续接 | `--resume` / `--continue` / `--session-id` / `--list-sessions` | 多轮交互映射到 `runTurn` 与 `mode: "session"` |
| 权限与工具 | `--permission-mode` / `--tools ""` / `--allowed-tools` / `--disallowed-tools` / `--sandbox` | 判定门槛第 4 条全靠它；默认一律选只读档 |
| 扩展 | `mcp` 子命令或 `--mcp-config` | 端聚合外部能力的入口，通常也是发现线索 |
| 认证 | 一次性 `login`（OAuth / 账号），状态可查（`login status`） | 登录是人的动作；未登录 → 输出「缺一次人工授权」 |

**适配策略**：先打通「无头单次 + 结构化输出」两样，落成任务型适配器；再按需补会话续接与权限档位，升级成会话型。两端不通时先怀疑自己对参数理解有误（用第 2.7 节第 4 条的非法取值探测法复核），不要怀疑套路本身。

## 4. 实例对照

以下参数全部来自对四个真实安装实例的实测（版本号、路径形态均为实测时所见，实测时间 2026-10-03；产品迭代后以 `--help` 实测为准）。路径用通配形式表示——照着这个形态去你自己的机器上找。

### 4.1 Codex（OpenAI，独立官方 CLI）

| 项 | 实测值 |
|---|---|
| 入口 | `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe`；数据目录 `~/.codex/` |
| 版本 | `codex-cli 0.155.0-alpha.16` |
| 登录 | `codex login status` 可查状态（实测已登录） |
| 无头单次 | `codex exec [PROMPT]`；另有 `exec resume` / `fork` / `review` |
| 结构化输出 | `codex exec --json` → JSONL 事件流 |
| `--json` 答案字段 | 答案在 `item.completed` 事件中 `item.type === "agent_message"` 的 `item.text`；而 `item.type === "error"` 是产品自身的**配置告警**，不是请求失败——不要把它映射成 `ok:false` |
| argv 限制 | `codex exec` **不接受顶层参数**：`codex exec --no-daemon -s bogus "x"` 报 `unexpected argument '--no-daemon'`、退出码 2；`-a/--ask-for-approval` 同理。argv 只能取 `codex exec --help` 里列出的选项，顶层选项不要混写进来 |
| 会话 | `codex resume`、`codex exec resume --last`、`codex queue`、`codex agents` |
| 守护进程 | `codex app-server`（含 `generate-ts` / `generate-json-schema`——产品自己生成协议类型，是「公开契约」的教科书例子） |
| 权限 / 沙箱 | `-s, --sandbox <MODE>`、`-c sandbox_permissions=[...]`；另有 `--dangerously-bypass-approvals-and-sandbox`（危险，不作默认） |
| 其它 | `-C/--cd <DIR>`、`--ephemeral`、`--output-last-message <FILE>`、`--skip-git-repo-check`、`mcp`、`doctor`、`plugin` |
| 发现路径 | WindowsApps 里两个零字节别名顺藤摸到 `%LOCALAPPDATA%\OpenAI\Codex\` |

### 4.2 WorkBuddy（应用内打包 CLI：CodeBuddy Code）

| 项 | 实测值 |
|---|---|
| 入口 | `<安装目录>\resources\app.asar.unpacked\cli\bin\codebuddy` |
| 包名 | `@genie/agent-cli`，bins = `codebuddy` / `cbc` / `codebuddy-code` |
| 版本 | `2.132.0` |
| 无头单次 | `-p, --print`（自述：Print response and exit，适合管道） |
| 结构化输出 | `--output-format text\|json\|stream-json`；`--input-format`；`--include-partial-messages`（原始增量）；`--json-schema <schema>`（结构约束） |
| 会话 | `-c/--continue`、`-r/--resume [sessionId]` |
| 权限 / 工具 | `--permission-mode`（acceptEdits / bypassPermissions / default / plan / dontAsk / auto）、`--tools ""`（全禁）、`--allowedTools` / `--disallowedTools` |
| MCP | `--mcp-config <fileOrString>` |
| 模型 | `--model`（auto / glm-5v-turbo / glm-5.1 / glm-5.0 / glm-4.7 / kimi-k2.5 / minimax-m2.7 / deepseek-v3-2-volc） |
| 发现路径 | 安装目录下 `resources\app.asar.unpacked\cli\`，`package.json` 的 `bin` 字段直接点名 |
| 坑 | 启动时警告找不到 Git Bash、自动回退 PowerShell；可用环境变量指定 Git Bash 路径或设置跳过检查 |

### 4.3 zCode（应用内 Node 包）

| 项 | 实测值 |
|---|---|
| 入口 | `<安装目录>\resources\glm\zcode.cjs`（Node 包，14.8 MB） |
| 版本 | `zcode 0.16.9`；`zcode doctor` 自述 `process: zcode-cli`、`node: v24.20.0` |
| 无头单次 | `-p, --prompt <text>`（自述：不开 TUI 跑单个 prompt） |
| 服务形态 | `app-server`：stdio 协议服务器 |
| 其它命令 | `tui` / `commands` / `skills` / `plugins`（插件市场）/ `login`（Z.AI OAuth）/ `logout` / `version` |
| 附加开关 | `--surface terminal\|desktop`、`--cwd`、`--attach <path>`、`--disallowed-tools`、`--browser-use headless` |
| 状态目录 | `~/.zcode/cli/`（agents / exec / db / plugins / rollout / config.json）——有这些目录说明该产品跑过 CLI |
| 发现路径 | 安装目录下 `resources\glm\`；用 `node <bundle> --help` 零成本确认 |

### 4.4 Qoder CN（公开 npm 包）

| 项 | 实测值 |
|---|---|
| 入口 | `npm i @qodercn-ai/qoderclicn`；bins = `qoderclicn` / `qodercn`（v1.1.65） |
| 官网自述 | terminal-native、automation-first、CI/CD 集成，并配 Agent SDK（`@qoder-ai/qoder-agent-sdk`） |
| 无头单次 | `-p, --print` |
| 结构化输出 | `-o, --output-format text\|json\|stream-json`（合法取值可故意传错探测） |
| 会话 | `--session-id`、`-r/--resume`、`-c/--continue`、`--list-sessions`、`--delete-session`、`--no-session-persistence` |
| 权限 / 工具 | `--permission-mode`（default / accept_edits / bypass_permissions / dont_ask / auto）、`--tools ""`、`--allowed-tools` / `--disallowed-tools` |
| MCP | `mcp` 子命令 + `--mcp-config` + `--strict-mcp-config` + `--allowed-mcp-server-names` |
| 长时运行 | `remote-control`（启动守护进程）、`--remote [task]`（云会话并打印访问 URL） |
| 登录 | 未登录时所有调用直接失败（提示请先登录）；`--list-models` 同样不可用 |
| 桌面版 shim | `~/.qoder-cn/entry/qoder-cn.cmd` 只是转发器——实测输出「CLI is not installed，请另行安装」 |

**关键对照**：四个产品两种登录态（已登录 / 未登录）都出现了；登录是人的动作，未登录不构成「不能接入」，只构成「缺一次人工授权」。
