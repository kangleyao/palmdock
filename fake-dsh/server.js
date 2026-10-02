// 可控假协议端：按 DeepSeek Harness（DSH）公开 /api 契约模拟一个最小、确定性的
// dsh web 服务器，供 dsh-agent 适配器的会话型契约测试使用（tests/dsh-session.test.ts）。
//
// 实现的协议子集（来源：DSH 产品自身的公开契约声明与包 README）：
//   - POST /api/<method>：body=ClientRequest{type:'client-request',rpcId,method,payload}，
//     响应体=ServerResponse{type:'server-response',rpcId,result:{ok,value}|{ok:false,error}}。
//   - POST /api/respond：body=ClientResponse{type:'client-response',rpcId,result:{ok:true,value}}，
//     响应体=RpcReceipt{accepted:true}|{accepted:false,reason:'not-pending'|'bad-response'}。
//   - WS /api/events.mux：ServerRequest 文本帧，payload 为 MuxFrame
//     （session/subscribed、session/event、question/requested、approval/requested、
//     question/resolved、approval/resolved、stream/error）。
//     连接建立时发 subscribed（每会话）并重放仍待答的 question/approval 帧
//     （复用同一 rpcId——官方“刷新恢复基线”行为）。
//   - WS /api/events.host：host/session-added、host/session-status 帧最小子集。
//   - 信任栅栏镜像：Host 必须为回环权威（127.0.0.1/localhost/[::1]），否则 403。
//   - 普通 GET 事件路径返回 426（官方明确“不保留 SSE 回退”）。
//   - session.create 的预分配幂等：同 id 重试返回同一会话。
//
// 场景（由消息内容选择，全部确定性、无随机）：
//   默认：turn/start → 分段输出 → 提问（精简版/详细版）→ 等回答 → 续行 → 成功
//   含“无提问”：无提问直抵成功
//   含“失败”：turn/end kind=error（端侧执行失败）
//   含“流错误”：stream/error 帧 + 失败终态
//   含“审批”：approval/requested（bash 工具请求）→ 等手机批准 → 续行成功
//   含“多题”：批量两问 → 适配器必须整批失败（dsh.question-batch）
//   含“多选”：multiSelect 提问 → 适配器必须失败不得降级（dsh.question-multiselect）
//   含“自由文本”：无选项提问 → 适配器必须失败不伪造选项（dsh.question-unrepresentable）
//   含“重复选项”：选项标签重复 → 适配器必须失败不产生歧义回答（dsh.question-duplicate-options）
//   含“断线”：chunk2 后断开全部 mux 连接，适配器按官方模型（拉历史 + 重开流）恢复
//   控制项：setFailCreate(true) 让 session.create 返回业务错误（测 rpc 错误映射）
"use strict";

const http = require("http");
const crypto = require("node:crypto");
const os = require("node:os");
const { WebSocketServer } = require("ws");

const MUX_PATH = "/api/events.mux";
const HOST_PATH = "/api/events.host";

function loopbackHost(header) {
  if (typeof header !== "string") return false;
  const hostname = header.split(":")[0].toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function nowIso() {
  return new Date().toISOString();
}

function startFakeDsh(opts) {
  const options = opts || {};
  return new Promise((resolve) => {
    const state = {
      sessions: new Map(),
      failCreate: false,
      responds: 0,
      prompts: 0,
      closed: false,
    };
    const muxClients = new Set();
    const hostClients = new Set();
    const timers = new Set();

    function later(fn, delay) {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!state.closed) fn();
      }, delay);
      timers.add(t);
      return t;
    }

    function reply(res, status, obj) {
      const body = JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    }

    function serverRequest(frame, rpcId) {
      return { type: "server-request", rpcId: rpcId || crypto.randomUUID(), method: "events.mux", payload: frame };
    }

    function broadcastMux(frame, rpcId) {
      const text = JSON.stringify(serverRequest(frame, rpcId));
      for (const c of muxClients) {
        if (c.readyState === 1) {
          try {
            c.send(text);
          } catch {
            // 客户端已断开：由 close 清理
          }
        }
      }
    }

    function broadcastHost(frame) {
      const text = JSON.stringify({ type: "server-request", rpcId: crypto.randomUUID(), method: "events.host", payload: frame });
      for (const c of hostClients) {
        if (c.readyState === 1) {
          try {
            c.send(text);
          } catch {
            // 同上
          }
        }
      }
    }

    // ---------------- 会话与事件 ----------------

    function createSession(sessionId) {
      const s = {
        sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
        prompts: 0,
        running: false,
        pendingQuestion: null,
        pendingApproval: null,
        resume: null,
        nextSeq: 0,
      };
      state.sessions.set(sessionId, s);
      broadcastHost({ type: "host/session-added", sessionId, blank: true, cwd: options.cwd || process.cwd() });
      return s;
    }

    function emit(sessionId, type, data) {
      const s = state.sessions.get(sessionId);
      if (!s) return;
      const event = { type, seq: s.nextSeq++, time: nowIso(), data };
      s.events.push(event);
      s.updatedAt = Date.now();
      broadcastMux({ type: "session/event", sessionId, event });
      return event;
    }

    function closeAllMux() {
      for (const c of muxClients) {
        try {
          c.close(1011, "server-restart-simulation");
        } catch {
          // 忽略
        }
      }
    }

    // ---------------- 确定性场景引擎 ----------------

    function scenarioFor(message) {
      if (message.includes("失败")) {
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "开始处理你的请求…" } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "遇到模拟错误" } },
          { kind: "event", type: "turn/end", data: { kind: "error", error: { message: "模拟失败：消息为“失败”" } } },
        ];
      }
      if (message.includes("流错误")) {
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "流式中…" } },
          { kind: "streamError", error: { code: "internal", message: "模拟实时流错误", details: {} } },
          { kind: "event", type: "turn/end", data: { kind: "error", error: { message: "流错误后终止" } } },
        ];
      }
      if (message.includes("审批")) {
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "我需要执行一个命令" } },
          { kind: "approve", toolName: "bash", reason: "执行 dir 列出目录" },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "已按权限决定继续" } },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "审批流程完成" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("断线")) {
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "断线场景：第一段" } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "断线场景：第二段" } },
          { kind: "closeMux" },
          { kind: "event", delay: 700, type: "assistant/chunk", data: { type: "text", text: "断线恢复后：第三段" } },
          { kind: "ask", questions: [
            { id: "q-reconnect", question: "重连后确认继续形式？", detail: "按所选形式整理恢复后的输出", options: [{ label: "精简版", description: "简略" }, { label: "详细版", description: "详尽" }] },
          ] },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "重连后继续执行" } },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "断线恢复完成" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("多题")) {
        // 批量提问（DSH 可一次发多问）：适配器应整批显式失败，不得只答首题。
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "多题场景：一次索取两个回答" } },
          { kind: "ask", questions: [
            { id: "q-multi-1", question: "第一问：输出语言？", options: [{ label: "中文" }, { label: "英文" }] },
            { id: "q-multi-2", question: "第二问：详略？", options: [{ label: "精简版" }, { label: "详细版" }] },
          ] },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "不应到达：多题应整轮失败" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("多选")) {
        // 多选提问：适配器不得降级成单选。
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "多选场景：需要勾选多项" } },
          { kind: "ask", questions: [
            { id: "q-multiselect", question: "要包含哪些章节？（可多选）", multiSelect: true, options: [{ label: "甲" }, { label: "乙" }, { label: "丙" }] },
          ] },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "不应到达：多选应整轮失败" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("自由文本")) {
        // 无选项的自由文本提问：适配器不得伪造选项。
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "自由文本场景：请输入任意内容" } },
          { kind: "ask", questions: [{ id: "q-freetext", question: "请用一段话描述你的需求" }] },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "不应到达：自由文本应整轮失败" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("重复选项")) {
        // 选项标签重复：单选按钮无法无歧义展示——适配器必须失败。
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "重复选项场景：两个选项同名" } },
          { kind: "ask", questions: [
            { id: "q-dup", question: "选择处理方式？", options: [{ label: "甲" }, { label: "甲" }, { label: "乙" }] },
          ] },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "不应到达：重复选项应整轮失败" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      if (message.includes("无提问")) {
        return [
          { kind: "event", type: "turn/start", data: { turn: 1 } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "无提问流程：第一段" } },
          { kind: "event", type: "assistant/chunk", data: { type: "text", text: "无提问流程：第二段" } },
          { kind: "event", type: "assistant/message", data: { type: "text", text: "无提问流程完成" } },
          { kind: "event", type: "turn/end", data: { kind: "normal" } },
        ];
      }
      return [
        { kind: "event", type: "turn/start", data: { turn: 1 } },
        { kind: "event", type: "assistant/chunk", data: { type: "text", text: "正在汇总你的请求…" } },
        { kind: "ask", questions: [
          { id: "q-format", question: "下一步用哪种方式生成结果？", detail: "结果会按所选形式整理", options: [{ label: "精简版", description: "简略概括" }, { label: "详细版", description: "详尽展开" }] },
        ] },
        { kind: "event", type: "assistant/chunk", data: { type: "text", text: "已按所选形式继续" } },
        { kind: "event", type: "assistant/message", data: { type: "text", text: "默认流程完成" } },
        { kind: "event", type: "turn/end", data: { kind: "normal" } },
      ];
    }

    function runScenario(sessionId, steps) {
      const s = state.sessions.get(sessionId);
      if (!s) return;
      s.running = true;
      broadcastHost({ type: "host/session-status", sessionId, running: true });
      let i = 0;
      const next = () => {
        if (state.closed || i >= steps.length) {
          finishScenario(sessionId, "normal");
          return;
        }
        const step = steps[i++];
        if (step.kind === "event") {
          // 先等够 delay 再发射：断线场景的“第三段”必须落在适配器重连窗口之后，
          // 否则它既不在历史快照里、也不会再被新连接重放（官方无 since 回放）而丢失。
          later(() => {
            emit(sessionId, step.type, step.data);
            next();
          }, step.delay || 80);
        } else if (step.kind === "closeMux") {
          closeAllMux();
          later(next, 80);
        } else if (step.kind === "streamError") {
          broadcastMux({ type: "stream/error", error: step.error });
          later(next, 80);
        } else if (step.kind === "ask") {
          const rpcId = crypto.randomUUID();
          s.pendingQuestion = { rpcId, questions: step.questions };
          // 场景在回答到达前暂停：respond 处理器调用 s.resume() 继续。
          broadcastMux({ type: "question/requested", sessionId, questions: step.questions }, rpcId);
          // resume 在此设置；若回答已在路上（不可能，因 ask 帧刚发出）——幂等处理。
        } else if (step.kind === "approve") {
          const rpcId = crypto.randomUUID();
          s.pendingApproval = { rpcId, approvalId: "appr-" + crypto.randomUUID().slice(0, 8), toolName: step.toolName, reason: step.reason };
          broadcastMux(
            { type: "approval/requested", sessionId, approvalId: s.pendingApproval.approvalId, toolName: step.toolName, reason: step.reason },
            rpcId
          );
        }
        // wait 由 ask/approve 步隐式承担：场景停在 ask/approve 之后，等 respond。
      };
      s.resume = next;
      next();
    }

    function finishScenario(sessionId, kind) {
      const s = state.sessions.get(sessionId);
      if (!s) return;
      s.running = false;
      s.resume = null;
      emit(sessionId, "turn/end", { kind });
      broadcastHost({ type: "host/session-status", sessionId, running: false });
    }

    // ---------------- HTTP /api 分发 ----------------

    function readBody(req) {
      return new Promise((res, rej) => {
        let data = "";
        req.on("data", (c) => {
          data += c;
          if (data.length > 4 * 1024 * 1024) rej(new Error("body too large"));
        });
        req.on("end", () => res(data));
        req.on("error", rej);
      });
    }

    function dispatch(method, payload) {
      if (method === "host.describe") {
        return { ok: true, value: { version: "fake-dsh/0.1", cwd: options.cwd || process.cwd(), attachedSessions: state.sessions.size, home: os.homedir(), canOpenPath: false } };
      }
      if (method === "session.list") {
        const items = Array.from(state.sessions.values())
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((s) => ({ sessionId: s.sessionId, updatedAt: s.updatedAt, running: s.running, blank: s.events.length === 0 }));
        return { ok: true, value: { items } };
      }
      if (method === "session.create") {
        if (state.failCreate) {
          return { ok: false, error: { code: "agent-preset-invalid", message: "模拟会话组合失败（failCreate）", details: {} } };
        }
        const id = payload && typeof payload.sessionId === "string" ? payload.sessionId : crypto.randomUUID();
        if (!state.sessions.has(id)) createSession(id);
        const s = state.sessions.get(id);
        return { ok: true, value: { sessionId: s.sessionId } };
      }
      if (method === "session.history") {
        const s = state.sessions.get((payload && payload.sessionId) || "");
        if (!s) return { ok: false, error: { code: "session-not-found", message: "session 不存在", details: { sessionId: (payload && payload.sessionId) || null } } };
        return { ok: true, value: { events: s.events.map((e) => ({ event: e })), hasMore: false } };
      }
      if (method === "session.prompt") {
        const sid = payload && payload.sessionId;
        const s = state.sessions.get(sid);
        if (!s) return { ok: false, error: { code: "session-not-found", message: "session 不存在", details: { sessionId: sid || null } } };
        if (!Array.isArray(payload.content) || !payload.content.some((b) => b && b.type === "text" && typeof b.text === "string")) {
          return { ok: false, error: { code: "bad-request", message: "content 必须含文本块", details: {} } };
        }
        const mode = payload.mode;
        if (mode !== "queue" && mode !== "steer") {
          return { ok: false, error: { code: "bad-request", message: "mode 必须为 queue/steer", details: {} } };
        }
        const text = payload.content.map((b) => b.text || "").join("");
        state.prompts += 1;
        s.prompts += 1;
        s.updatedAt = Date.now();
        emit(sid, "user/message", { content: [{ type: "text", text }] });
        later(() => runScenario(sid, scenarioFor(text)), 60);
        return { ok: true, value: { accepted: true } };
      }
      return { ok: false, error: { code: "bad-request", message: `未知方法：${method}`, details: {} } };
    }

    async function handleApi(req, res) {
      if (!loopbackHost(req.headers.host)) {
        reply(res, 403, { error: "forbidden: host authority not loopback" });
        return;
      }
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if ((path === MUX_PATH || path === HOST_PATH) && req.method === "GET") {
        reply(res, 426, { error: "upgrade required" });
        return;
      }
      if (!path.startsWith("/api/") || req.method !== "POST") {
        reply(res, 404, { error: "not found" });
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        reply(res, 400, { error: "bad body" });
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        reply(res, 400, { error: "bad json" });
        return;
      }
      if (path === "/api/respond") {
        // ClientResponse：rpcId 回显；找到待答的 question/approval 才接受。
        const rpcId = envelope && envelope.rpcId;
        let resolved = false;
        for (const s of state.sessions.values()) {
          if (s.pendingQuestion && s.pendingQuestion.rpcId === rpcId) {
            broadcastMux({ type: "question/resolved", sessionId: s.sessionId, questionRpcId: rpcId, outcome: "answered" });
            s.pendingQuestion = null;
            state.responds += 1;
            const resume = s.resume;
            s.resume = null;
            resolved = true;
            reply(res, 200, { accepted: true });
            if (resume) later(resume, 80);
            return;
          }
          if (s.pendingApproval && s.pendingApproval.rpcId === rpcId) {
            const value = (envelope.result && envelope.result.value) || {};
            const outcome = value.outcome === "allowed-once" ? "allowed-once" : "rejected";
            broadcastMux({ type: "approval/resolved", sessionId: s.sessionId, approvalId: s.pendingApproval.approvalId, outcome });
            s.pendingApproval = null;
            state.responds += 1;
            const resume = s.resume;
            s.resume = null;
            resolved = true;
            reply(res, 200, { accepted: true });
            if (resume) later(resume, 80);
            return;
          }
        }
        if (!resolved) {
          reply(res, 200, { accepted: false, reason: "not-pending" });
        }
        return;
      }
      if (!envelope || envelope.type !== "client-request" || typeof envelope.method !== "string") {
        reply(res, 400, { error: "bad envelope" });
        return;
      }
      const result = dispatch(envelope.method, envelope.payload);
      reply(res, 200, { type: "server-response", rpcId: envelope.rpcId, result });
    }

    // ---------------- WebSocket 升级 ----------------

    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
      handleApi(req, res).catch((e) => {
        try {
          reply(res, 500, { error: String(e && e.message || e) });
        } catch {
          // 响应已写出则忽略
        }
      });
    });

    server.on("upgrade", (req, socket) => {
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (!loopbackHost(req.headers.host)) {
        socket.destroy();
        return;
      }
      if (path !== MUX_PATH && path !== HOST_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
        if (path === MUX_PATH) {
          muxClients.add(ws);
          // 官方刷新恢复基线：连接即订阅（每会话 subscribed + lastSeq），并重放待答帧。
          for (const s of state.sessions.values()) {
            ws.send(JSON.stringify(serverRequest({ type: "session/subscribed", sessionId: s.sessionId, lastSeq: s.nextSeq - 1 })));
          }
          for (const s of state.sessions.values()) {
            if (s.pendingQuestion) {
              ws.send(
                JSON.stringify(
                  serverRequest({ type: "question/requested", sessionId: s.sessionId, questions: s.pendingQuestion.questions }, s.pendingQuestion.rpcId)
                )
              );
            }
            if (s.pendingApproval) {
              ws.send(
                JSON.stringify(
                  serverRequest(
                    { type: "approval/requested", sessionId: s.sessionId, approvalId: s.pendingApproval.approvalId, toolName: s.pendingApproval.toolName, reason: s.pendingApproval.reason },
                    s.pendingApproval.rpcId
                  )
                )
              );
            }
          }
          ws.on("close", () => muxClients.delete(ws));
          ws.on("error", () => {
            try {
              ws.close();
            } catch {
              // 忽略
            }
          });
        } else {
          hostClients.add(ws);
          ws.on("close", () => hostClients.delete(ws));
          ws.on("error", () => {
            try {
              ws.close();
            } catch {
              // 忽略
            }
          });
        }
      });
    });

    server.listen(options.port || 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        state,
        setFailCreate(v) {
          state.failCreate = v;
        },
        close() {
          state.closed = true;
          for (const t of timers) clearTimeout(t);
          timers.clear();
          for (const c of muxClients) {
            try {
              c.close(1001, "fake-dsh-shutdown");
            } catch {
              // 忽略
            }
          }
          for (const c of hostClients) {
            try {
              c.close(1001, "fake-dsh-shutdown");
            } catch {
              // 忽略
            }
          }
          wss.close();
          server.close();
        },
      });
    });
  });
}

if (require.main === module) {
  startFakeDsh({ port: Number(process.env.DSH_FAKE_PORT) || 0 }).then((srv) => {
    console.log(`fake-dsh listening on ${srv.baseUrl} (mux/host WS, POST /api/*)`);
  });
}

module.exports = { startFakeDsh };
