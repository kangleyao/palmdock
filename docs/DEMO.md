# 演示指南（掌坞）

> 一句话定位：**一个可运行的通用手机/电脑 AI 交互底座（演示项目）**——默认页面、会话与连接机制是公共可复用的；具体 Agent/工具的差异集中在 `src/adapters/` 里适配，任何开发者照 `ADAPTERS.md` 即可新增端。

本文档可照着演示；所有命令、路径、地址均已按当前仓库实现核对。验证状态与已知缺口见 `docs/VERIFICATION.md`。

## 演示前检查（约 10 秒）

要演示完整流程（真实 AI 对话），需要三项：底座主服务、指向真实 DSH 的独立实例、以及真实 DSH 本身。只演示本地假 AI 与一次性任务时，只需要第一项。

```powershell
# 在仓库根目录下执行（以下命令均在此目录）
# 1) 主服务（常驻；如未运行）
npm run serve                 # WMI 独立进程；端口取自 config.json 的 port（本文示例实例为 8811）
# 2) 指向真实 DSH 的独立实例（如未运行；可选，仅演示 dsh-agent 时需要）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve-dsh.ps1
#   以 WMI 启动 dsh-instance\（独立配置与数据，端口 8812，DSH_BASE_URL=http://127.0.0.1:3080）
# 3) 正式 DSH：由用户启动（内嵌 dsh web 监听 127.0.0.1:3080，回环，不暴露公网）

# 健康检查（两者都应 200）
Invoke-WebRequest http://127.0.0.1:8811/api/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8812/api/health -UseBasicParsing
```

手机入口（与电脑同一 Wi-Fi）：`http://192.168.x.x:8812/`（局域网 IP 以实际为准，可用
`Get-NetIPAddress -AddressFamily IPv4` 查）。局域网地址是当前唯一已验证的手机入口
（Tailscale 等跨网路径未实测、也未在两端安装，不作为可用入口列出）。
首次打开输入一次访问 token（来自电脑上 `config.json`；见 README 的 `npm run token` 说明）。

**录像/公开演示注意**：token 是访问口令，**不要在镜头里输入、朗读或截到**；输入框是 password
类型不回显，保存后仅存本机浏览器。局域网模式为**明文 HTTP**：同 Wi-Fi 设备只要拿到
token 即可访问，演示时强调"仅可信网络"，跨网方案见 `docs/CLOUDFLARE-TUNNEL.md`（未实测）。

## 90–150 秒演示台本

| 时间 | 动作 | 要点 |
| --- | --- | --- |
| 0–20s | 上面三项健康检查 | 三项各司其职：底座 / DSH 实例 / 正式 DSH |
| 20–40s | 手机（或桌面窄屏）打开 8812 | 先是配对卡：填访问口令 → 直达会话主页（已有会话列表 + 新建会话）；一次性任务端收进顶栏「工具」图标的二级页 |
| 40–60s | 主页内新建会话 | 端下拉 + **能力描述行**（如"流式输出 · 可向你提问 · 可列会话"，含 dsh-agent 的支持子集与限制）；`dsh-agent` 描述明确"仅支持单题、单选、选项无重复" |
| 60–100s | 讲**已经实际发生过的**真实交互（事实，非推断） | 用户已用自己的手机经 8812 与正式 DSH 完成过：发消息 → **收到结构化提问** → 手机**点选**（如"方案 A"类选项）→ **得到回复并成功**（服务端另可观察到该会话 3 轮记录、末轮成功） |
| 100–115s | 提醒环节 | 手机会响（提问声/完成声）、会振动、标签页标题闪烁【待回答】、会话页顶部出现"收到提问"提示条；可在会话页"开启提醒"试听，"关闭提醒"后声音与振动零残留 |
| 115–135s | 刷新会话页 | 历史轮次、问答、结果全部仍在（服务端持久化；断网续传 / sinceSeq 重放仅由自动化脚本验证，未经真机断网场景确认；**再次打开会话页先用本地缓存秒开再向服务器刷新**——页面顶部会短暂标注"更新中…"，断网时显示"离线，显示的是上次内容"） |
| 135–150s（可选） | fake-ai 失败演示 | 会话页发"失败"→ 端侧失败 → 页面红色失败样式 + 失败原因与阶段 |

**现场再做一次真实交互时**：由**用户自己**选一个不敏感的空白任务（如"写一首短诗"）并**自己点发送**——
发消息即是对正式 DSH 的真实 prompt；如果 DSH 发来审批请求，由**用户**在手机上选"允许一次/拒绝"，
演示者**不代发、不代批**。

**不要声称的**：页面推流的是**端产生的公开事件**（分段输出文本、状态徽标、提问卡片），**不是**
AI 助手的内部推理过程实时显示——底座只呈现端的对外事件，这与"展示 AI 思考过程"不是一回事。

## 适配器边界与文件（演示"差异集中在适配器"）

| 端 | 文件 | 形态与边界 |
| --- | --- | --- |
| fake-ai（演示助手） | `src/adapters/fake-ai.ts` + `fake-ai/agent.js` | 纯本地 stdio 演示端；确定性；不联网、无密钥 |
| text-stats / dir-listing / inkstone-* | `src/adapters/*.ts` | 一次性任务端（第一层） |
| dsh-agent | `src/adapters/dsh-agent.ts` | 按 DSH `/api` 协议接入真实 Agent；`DSH_BASE_URL` 必须回环；**多题/多选/自由文本/重复选项 → 整轮显式失败**（不降级、不自动回答）；**审批由用户决定，适配器绝不代批** |
| android-shell（示例客户端，可选） | `android-shell/` | 原生通知壳；**不是框架的一部分**，可整目录删除 |
| 下一端（你） | `src/adapters/<your-end>.ts` | 照 `ADAPTERS.md` 增量新增；公共页面/连接机制复用，不必重写 |

## 从零安装与测试（可复现命令，已实测）

以下 4 组对照在本机实测过两遍（主项目与纯源码副本，Node v24.20.0 / npm 11.19.0）：

1. 空目录只有 `package.json` + `tsconfig.json`（**无 `package-lock.json`**）时，`npm install --no-audit --no-fund`
   **成功**（`added 85 packages in 8s`），`require('better-sqlite3')` 正常。
2. 带主项目同一份 `package-lock.json` 时，`npm install --no-audit --no-fund` **失败**：npm 对
   `node_modules/better-sqlite3` 执行 `node-gyp rebuild`，报 `Could not find any Visual Studio installation
   to use`（本机无 VS C++ 工具链）。注意 better-sqlite3@13.0.3 的 npm 包**本身没有 install 脚本**
   （其 `scripts` 只有 build-release/build-debug/test/benchmark/download/clean），但日志与告警显示
   npm 把它的 install 步骤识别为 `node-gyp rebuild`（`npm warn install-scripts … better-sqlite3@13.0.3
   (install: node-gyp rebuild)`）。**为何仅在带 lock 时触发构建，机制未查明**——只记录可复现现象。
3. 带 lock 时改用 `npm install --ignore-scripts --no-audit --no-fund`：**成功**（`added 85 packages in 1s`），
   `better-sqlite3` 各平台预编译二进制齐全（`prebuilds/win32-x64.node` 等 8 个，随 tarball 提供），
   `require` + 建表/插入/查询全正常。该依赖集**没有需要本地编译的包**，忽略脚本不影响任何功能。
4. 在纯源码副本上：`npm install --ignore-scripts`
   → `added 85 packages in 1s`（exit=0）→ `npm test` → **tests 137 / pass 117 / fail 0 / cancelled 0 / skipped 20**（exit=0），
   与主项目完全一致；再删掉 `dist/` 与 `data/` 后跑第二次，同样 **137/117/0/20**（不依赖任何预置产物）。
   **安装会改写 lock**：`npm install` 给 `package-lock.json` 里 `better-sqlite3` 条目补了一行 `"hasInstallScript": true`
   （差异仅此一行，1079→1080 行）——这正是前两条"带 lock 时 npm 会触发 node-gyp rebuild"的可观测线索；
   装好后可按原样还原 lock 文件。
   **因此全新安装是可验证的，命令是 `npm install --ignore-scripts`。**

> 离线/受限环境退路：若某机器无法联网安装，可从已装好的项目整体复制 `node_modules/`（其中
> `better-sqlite3` 的预编译二进制随版本绑定，换 Node 大版本需重装）。

## 尚未做 & 失败处理

- **跨网访问**未做：明文 HTTP 局域网是当前唯一可用形态；`docs/CLOUDFLARE-TUNNEL.md` 仅为方案文档，未实测。
- **真实会话级深度**：真实模型长对话、多轮审批、真实多题场景未验证（依赖用户授权真实 prompt，未代做）。
- **失败如何呈现**：任何端失败都以轮次 `failed` + `error.message` + `error.stage`（如
  `dsh.turn-end` / `dsh.stream-error` / `dsh.question-batch`）落盘；页面红色失败卡片；
  断线不丢已显示内容，重连后 `sinceSeq` 续传；服务重启未终结轮次标记 `interrupted`（不重跑、不伪称结果）。
- **每会话单活轮次**：进行中再发消息返回 `409 SESSION_BUSY`，页面提示先回答或等待。

## 一致性核对清单（写文档时复核过）

- 脚本存在且与启动方式一致：`scripts/serve.ps1`（8811）、`scripts/serve-dsh.ps1`（8812）
- 健康端点 `/api/health`、工具清单 `/api/tools`（鉴权头）、会话主页 `/session.html`、工具页 `/tools.html`、入口跳转桩 `/`（→ `/session.html`）
- 适配器目录即 `src/adapters/`；公共页面在 `public/`
- 本文档不含 token、会话 ID、私人对话内容；示例均为结构性事实或可复现命令。
