"use strict";
// 公共客户端：token 管理、HTTP 轮询、会话 SSE 流、浏览器通知探测、会话快照本地缓存；
// 渲染一律用 DOM API（createElement + createTextNode + textContent），无动态 HTML 注入；AI 正文支持安全 Markdown 子集。
// 明文 HTTP 下不依赖仅 HTTPS 可用的浏览器 API（如 crypto.randomUUID / navigator.clipboard）；
// 通知能力先探测再用，不支持时退化为页内横幅 + 标题徽标 + 振动提醒。

var TOKEN_KEY = "agb_token";

function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
}

function setToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch (e) {
    // 隐私模式下 localStorage 不可用也能用：退到内存
    tokenMemory = token;
  }
}

var tokenMemory = "";
function tokenEffective() {
  var t = getToken();
  return t || tokenMemory;
}

function uuid() {
  // getRandomValues 在普通 HTTP 页面可用；randomUUID 需要安全上下文，故不用。
  var buf = new Uint8Array(16);
  window.crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  var hex = [];
  for (var i = 0; i < 16; i++) hex.push(buf[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") + "-" +
    hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" +
    hex.slice(8, 10).join("") + "-" +
    hex.slice(10, 16).join("")
  );
}

function el(tag, text, cls) {
  var node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
/** 统一加载态：骨架屏（list 列表 3 条灰块 / chat 聊天 2 个气泡块 / card 卡片 3 块），1.4s 呼吸，替代长驻 spinner。节点只在加载时创建一次，不随重渲染重建。 */
function loadingPlaceholder(kind) {
  var wrap = el("div", null, "sk-wrap");
  var n = kind === "chat" ? 2 : 3;
  for (var i = 0; i < n; i++) {
    var cls = "sk " + (kind === "chat" ? "sk-bubble" + (i === 1 ? " short" : "") : kind === "card" ? "sk-card" : "sk-row");
    wrap.appendChild(el("div", null, cls));
  }
  return wrap;
}

/** 统一空态：一句话 + 可选动作按钮（如“创建第一个会话”） */
function emptyGuide(text, actionLabel, actionFn) {
  var div = el("div", null, "empty-guide");
  div.appendChild(el("p", text));
  if (actionLabel) {
    var b = el("button", actionLabel, "btn");
    b.type = "button";
    b.addEventListener("click", function () { if (actionFn) actionFn(); });
    div.appendChild(b);
  }
  return div;
}

// ---------------- 安全 Markdown 渲染（AI 回复正文与结果卡正文） ----------------
// 红线：解析结果一律用 DOM API（createElement + createTextNode + textContent）构造，
// Markdown 原文里的 HTML 字符（< > &）永远只是文本字符，浏览器不会当作标签解释执行；
// 红线：解析结果一律用 DOM API（createElement + createTextNode + textContent）构造，
// Markdown 原文里的 HTML 字符（< > &）永远只是文本字符，浏览器不会当作标签解释执行；
// 全程不使用动态 HTML 注入与字符串求值；不引入外部库。
// 链接仅允许 http/https，其余协议（javascript: / data: / 相对协议等）一律降级为字面文本。

/** 追加一个文本节点（文本内容永不被解释为 HTML）。 */
function mdTextNode(parent, text) {
  parent.appendChild(document.createTextNode(text));
}

/**
 * 内联 Markdown：行内代码（最高优先级，内部不再解析）→ 粗体 → 斜体 → 链接 → 字面字符。
 * 粗体/斜体内部递归解析（**[链接](https://…) 与 *嵌套* 均成立）。
 */
function renderInlineMarkdown(parent, text) {
  var i = 0;
  var buf = "";
  function flush() {
    if (buf !== "") { mdTextNode(parent, buf); buf = ""; }
  }
  while (i < text.length) {
    var rest = text.slice(i);
    var m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      var code = document.createElement("code");
      code.className = "md-code";
      code.textContent = m[1];
      parent.appendChild(code);
      i += m[0].length;
      continue;
    }
    m = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (m) {
      flush();
      var strong = document.createElement("strong");
      renderInlineMarkdown(strong, m[1]);
      parent.appendChild(strong);
      i += m[0].length;
      continue;
    }
    m = /^\*([^*\n]+)\*/.exec(rest);
    if (m) {
      flush();
      var em = document.createElement("em");
      renderInlineMarkdown(em, m[1]);
      parent.appendChild(em);
      i += m[0].length;
      continue;
    }
    m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      if (/^https?:\/\//i.test(m[2])) {
        var a = document.createElement("a");
        a.className = "md-link";
        a.href = m[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = m[1];
        parent.appendChild(a);
      } else {
        // 非法/不支持的协议：整段按字面文本呈现（用户看到的就是原始写法，无法被点击执行）
        mdTextNode(parent, m[0]);
      }
      i += m[0].length;
      continue;
    }
    buf += text.charAt(i);
    i += 1;
  }
  flush();
}

/** 闭合围栏判定：同一字符（` 或 ~）组成、长度不短于开启围栏（允许首尾空白）。 */
function mdIsClosingFence(line, fence) {
  var t = String(line).replace(/^\s+/, "").replace(/\s+$/, "");
  if (t.length < fence.length) return false;
  for (var c = 0; c < t.length; c++) {
    if (t.charAt(c) !== fence.charAt(0)) return false;
  }
  return true;
}

/**
 * 块级 Markdown 解析并渲染进 host：围栏代码块（```/~~~）、ATX 标题（# ~ ######，1–6 级）、分隔线（---/***）、
 * 引用（> ）、无序列表（- * + ）、有序列表（1. / 1) ）、空行分段；段内单换行渲染为 <br>。
 * 每一种节点都只经 DOM API 构造，原文中的 HTML 标签天然是文本。
 */
function renderMarkdownInto(host, source) {
  var lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  var i = 0;
  var para = [];

  function flushPara() {
    if (para.length === 0) return;
    var p = document.createElement("div");
    p.className = "md-p";
    for (var k = 0; k < para.length; k++) {
      if (k > 0) p.appendChild(document.createElement("br"));
      renderInlineMarkdown(p, para[k]);
    }
    host.appendChild(p);
    para = [];
  }

  while (i < lines.length) {
    var line = lines[i];
    // 围栏代码块（``` 或 ~~~，可带语言标记）
    var fenceMatch = /^\s*(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/.exec(line);
    if (fenceMatch) {
      flushPara();
      var fence = fenceMatch[1];
      var codeLines = [];
      i += 1;
      while (i < lines.length && !mdIsClosingFence(lines[i], fence)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过闭合围栏；未闭合则直接渲染到末尾
      var pre = document.createElement("pre");
      pre.className = "md-code-block";
      var codeEl = document.createElement("code");
      codeEl.textContent = codeLines.join("\n"); // 纯文本：代码内容绝不被解析
      pre.appendChild(codeEl);
      host.appendChild(pre);
      continue;
    }
    // ATX 标题：行首最多 3 个空格 + 连续 1–6 个 # + 至少一个空白 + 非空内容；行尾可选闭合井号剥掉
    // 保守判定（不误判）：#标签（井号后无空白）、单独 #（无内容）、7 个及以上井号 → 都不是标题，按原段落
    var headingMatch = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    if (headingMatch) {
      var level = headingMatch[1].length;
      var headingText = headingMatch[2].replace(/[ \t]+#+[ \t]*$/, "").replace(/[ \t]+$/, "");
      if (headingText !== "") {
        flushPara();
        var heading = document.createElement("h" + level);
        heading.className = "md-h" + level;
        renderInlineMarkdown(heading, headingText);
        host.appendChild(heading);
        i += 1;
        continue;
      }
    }
    // 分隔线：--- / *** / ___（三个及以上相同字符）
    if (/^\s*([-*_])\1{2,}[ \t]*$/.test(line)) {
      flushPara();
      host.appendChild(el("hr", null, "md-hr"));
      i += 1;
      continue;
    }
    // 引用：连续的 > 行合并为一个引用块（内部递归解析）
    if (/^\s*>/.test(line)) {
      flushPara();
      var quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>[ \t]?/, ""));
        i += 1;
      }
      var quote = document.createElement("blockquote");
      quote.className = "md-quote";
      renderMarkdownInto(quote, quoteLines.join("\n"));
      host.appendChild(quote);
      continue;
    }
    // 无序列表：- / * / + 后接空白
    if (/^\s*[-*+][ \t]+/.test(line)) {
      flushPara();
      var ul = document.createElement("ul");
      ul.className = "md-ul";
      while (i < lines.length && /^\s*[-*+][ \t]+/.test(lines[i])) {
        var li = document.createElement("li");
        li.className = "md-li";
        renderInlineMarkdown(li, lines[i].replace(/^\s*[-*+][ \t]+/, ""));
        ul.appendChild(li);
        i += 1;
      }
      host.appendChild(ul);
      continue;
    }
    // 有序列表：1. / 1) 后接空白
    if (/^\s*\d+[.)][ \t]+/.test(line)) {
      flushPara();
      var ol = document.createElement("ol");
      ol.className = "md-ol";
      while (i < lines.length && /^\s*\d+[.)][ \t]+/.test(lines[i])) {
        var oli = document.createElement("li");
        oli.className = "md-li";
        renderInlineMarkdown(oli, lines[i].replace(/^\s*\d+[.)][ \t]+/, ""));
        ol.appendChild(oli);
        i += 1;
      }
      host.appendChild(ol);
      continue;
    }
    // 空行：段落分隔
    if (/^\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line.replace(/^\s+/, "").replace(/[ \t]+$/, ""));
    i += 1;
  }
  flushPara();
}

/**
 * 结果卡可读正文（保守实现）：仅当结果对象直接含非空字符串字段
 * summary / message / text / assistantText 时返回该字段；其余情况一律返回 null（维持原始 JSON，不猜测结构）。
 * assistantText 由第 13 轮加入：DSH 端把回答正文放进 result.assistantText，此前落到原始 JSON 直出，
 * 既不可读又与 AI 气泡重复（正文同一段被渲染两次）。
 */
function readableResultText(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  var keys = ["summary", "message", "text", "assistantText"];
  for (var i = 0; i < keys.length; i++) {
    var v = result[keys[i]];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * 同轮正文去重：若该文本已作为本轮 AI 气泡渲染过，结果卡不再重复整段正文（只留短状态 + 原始结果折叠）。
 * 保守设计：判定不上就当没渲染过——多显示一次正文也比漏显示强。
 */
function isAnswerAlreadyRendered(rec, text) {
  if (!rec || !rec.renderedAnswers || typeof text !== "string" || text === "") return false;
  return Object.prototype.hasOwnProperty.call(rec.renderedAnswers, text);
}
/** 结果卡“查看原始结果”：可展开的原始 JSON（复用过程抽屉的按钮样式，纯 DOM）。label 可换为“查看技术细节”等。 */
function appendRawResultToggle(card, result, label) {
  var closedLabel = label || "查看原始结果";
  var openLabel = closedLabel.indexOf("查看") === 0 ? "收起" + closedLabel.slice(2) : "收起" + closedLabel;
  var toggle = el("button", closedLabel, "ev-tray-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  var raw = el("pre", JSON.stringify(result, null, 2), "code raw-result hidden");
  var expanded = false;
  toggle.addEventListener("click", function () {
    expanded = !expanded;
    raw.classList.toggle("hidden", !expanded);
    toggle.textContent = expanded ? openLabel : closedLabel;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  });
  card.appendChild(toggle);
  card.appendChild(raw);
}

// ---------------- 会话快照本地缓存（秒开） ----------------

/**
 * 失败阶段的人话主文案（技术代号 endpoint.fatal 等不再直接给用户看，
 * 原始代号与错误对象保留在“查看技术细节”折叠里）。未知的人话阶段原样返回。
 */
function humanStage(stage) {
  var s = String(stage || "");
  if (!s) return "";
  if (s.indexOf("endpoint") === 0) return "连接这个端时失败了";
  if (s.indexOf("rpc") === 0) return "与端通信时失败了";
  if (s.indexOf("lookup") === 0) return "准备执行时失败了";
  if (s.indexOf("adapter") === 0) return "调用端工具时失败了";
  if (s.indexOf("input") === 0) return "输入未通过校验";
  if (s.indexOf("catalog") === 0) return "读取工具清单时失败了";
  if (s.indexOf("mcp") === 0) return "与工具服务器通信时失败了";
  if (s.indexOf("result") === 0) return "整理结果时失败了";
  if (s.indexOf("answer") === 0) return "处理你的回答时失败了";
  if (s.indexOf("tool") === 0) return "执行工具时失败了";
  if (/[._]/.test(s)) return "执行中出现错误"; // 其余技术代号一律不当主文案
  return s;
}
// 按会话 id 存最近一次快照，打开页面时先渲染缓存再向服务器刷新；带 schema 版本号，
// 不匹配直接忽略。只存快照内容本身，绝不存 token / 口令 / 鉴权信息。
// 写入防抖（快照频繁到达时不逐次写盘）；localStorage 不可用或配额不足一律静默降级
// （缓存只是体验优化项，失败不影响任何功能）。

var SESSION_CACHE_VERSION = 1;
var sessionCacheTimers = {};

function sessionCacheKey(sessionId) { return "agb_sess_" + sessionId; }

/** 读缓存：版本不匹配、结构不符或解析失败一律返回 null（忽略旧缓存）。 */
function readSessionCache(sessionId) {
  if (!sessionId) return null;
  try {
    var raw = window.localStorage.getItem(sessionCacheKey(sessionId));
    if (!raw) return null;
    var obj = JSON.parse(raw);
    if (!obj || obj.v !== SESSION_CACHE_VERSION) return null;
    var snap = obj.snapshot;
    if (!snap || !snap.session || typeof snap.session !== "object" || !Array.isArray(snap.turns)) return null;
    return snap;
  } catch (e) {
    return null;
  }
}

/** 写缓存（防抖 300ms）：只存快照本身，绝不含 token。 */
function writeSessionCache(sessionId, snapshot) {
  if (!sessionId) return;
  if (sessionCacheTimers[sessionId]) window.clearTimeout(sessionCacheTimers[sessionId]);
  sessionCacheTimers[sessionId] = window.setTimeout(function () {
    delete sessionCacheTimers[sessionId];
    try {
      window.localStorage.setItem(
        sessionCacheKey(sessionId),
        JSON.stringify({ v: SESSION_CACHE_VERSION, savedAt: Date.now(), snapshot: snapshot })
      );
    } catch (e) { /* 隐私模式 / 配额不足：缓存不可用不影响功能 */ }
  }, 300);
}
// ---------------- 事件多来源去重 / 合并（纯函数） ----------------
// 背景：会话事件有两个来源——GET /api/sessions/:id 只带焦点轮次的事件（字段名 taskId，
// 来自同一 store 行），SSE hello/change 带 sinceSeq 之后的会话级事件（字段名 turnId，
// 值与 taskId 相同）。两者的“事件集”不同：先按单一单调水位去重会让先到的那份把后到的
// 整份跳过、永久丢历史事件；因此渲染去重按已渲染集合，SSE 游标单独只由流数据推进。

/** 事件去重 key：(turnId|taskId) 与 seq 组合。两来源对同一事件的这两个字段值相同。 */
function eventDedupeKey(ev) {
  if (!ev) return "?|?";
  var tid = ev.turnId || ev.taskId || "?";
  return tid + "|" + ev.seq;
}

/** 最大 seq（SSE 游标推进用）：seq 非数字的事件不计。 */
function maxEventSeq(events) {
  var m = 0;
  (events || []).forEach(function (ev) {
    if (ev && typeof ev.seq === "number" && ev.seq > m) m = ev.seq;
  });
  return m;
}

/**
 * 合并多份事件列表：按 (turnId|taskId, seq) 去重，按 seq 升序（同 seq 保持出现顺序）。
 * 用于把多个来源的事件合并成本页实际渲染的累积集（本地缓存写入用，无损）。
 */
function mergeEventLists(lists) {
  var seen = {};
  var out = [];
  (lists || []).forEach(function (list) {
    (list || []).forEach(function (ev) {
      if (!ev) return;
      var key = eventDedupeKey(ev);
      if (seen[key]) return;
      seen[key] = true;
      out.push(ev);
    });
  });
  out.sort(function (a, b) {
    var sa = typeof a.seq === "number" ? a.seq : Infinity;
    var sb = typeof b.seq === "number" ? b.seq : Infinity;
    if (sa !== sb) return sa - sb;
    return 0; // 同 seq 保留首次出现顺序（V8 sort 稳定）
  });
  return out;
}

var STATUS_LABELS = {
  pending: "等待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  interrupted: "中断（结果未知）",
};

/** 事件类型的友好标签（信息/提醒/进度/系统；任务详情页日志头与过程抽屉行用）。 */
var EVENT_TYPE_LABELS = { info: "信息", warning: "提醒", progress: "进度", system: "系统" };
var EVENT_TYPE_CLASS = { warning: "ev-warn", progress: "ev-progress" };

/**
 * 事件分类：决定默认渲染形态。
 * - answer：端的回答正文/输出内容 → 对话气泡（默认视图只呈现“对话本身”）
 * - process：过程事件（连接/提交/开始执行/进度/问答回执）→ 收进“过程 · N 条”可展开细节
 * - attention：提醒与系统注意项 → 默认可见，绝不藏（异常、失败、需用户注意的事件）
 * 未知端的 info 事件默认按 answer 处理：宁可多显示，不可漏内容。
 */
var PROCESS_INFO_PREFIXES = [
  "【等待你的回答】", // 会话框架的提问回执：提问卡本身已醒目渲染
  "已连接 DSH 实时事件流",
  "消息已提交给 DSH 会话（第 ",
  "DSH 端已开始本轮执行",
  "演示助手已启动（本地运行，第 ",
];
var PROCESS_SYSTEM_PREFIXES = ["已收到你的回答："]; // 回答回执：气泡卡上已有“已回答”chip

function classifyEvent(ev) {
  var type = (ev && ev.type) || "info";
  var msg = (ev && ev.message) || "";
  var i;
  if (type === "warning") return "attention";
  if (type === "progress") return "process";
  if (type === "system") {
    for (i = 0; i < PROCESS_SYSTEM_PREFIXES.length; i++) {
      if (msg.slice(0, PROCESS_SYSTEM_PREFIXES[i].length) === PROCESS_SYSTEM_PREFIXES[i]) return "process";
    }
    return "attention";
  }
  for (i = 0; i < PROCESS_INFO_PREFIXES.length; i++) {
    if (msg.slice(0, PROCESS_INFO_PREFIXES[i].length) === PROCESS_INFO_PREFIXES[i]) return "process";
  }
  return "answer";
}

/** 列表行用的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 月-日。 */
function relTime(iso) {
  if (!iso) return "";
  var t = new Date(iso);
  if (isNaN(t.getTime())) return "";
  var diff = Math.max(0, Date.now() - t.getTime());
  var m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  var h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  var d = Math.floor(h / 24);
  if (d < 7) return d + " 天前";
  return (t.getMonth() + 1) + "-" + t.getDate();
}

/** 过程抽屉按钮文案（收起状态一眼可辨）。 */
function trayLabel(count, expanded) {
  return expanded ? "收起过程 · " + count + " 条" : "过程 · " + count + " 条";
}

/** 统一 API 调用；失败分类：network（无法区分具体原因）/ unauthorized / http */

/** 任务详情页的事件日志头（那里就是日志视图，保留类型/时间/进度）。 */
function eventHead(ev) {
  var label = EVENT_TYPE_LABELS[ev.type] || ev.type;
  var head = label + " · " + new Date(ev.createdAt).toLocaleTimeString();
  if (ev.percent !== null && ev.percent !== undefined) head += " · " + ev.percent + "%";
  return head;
}
function apiCall(path, opts) {
  opts = opts || {};
  var headers = { "content-type": "application/json" };
  var token = tokenEffective();
  if (token) headers["authorization"] = "Bearer " + token;
  if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
  return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body })
    .then(function (res) {
      if (res.status === 401) {
        var e1 = { kind: "unauthorized", message: "未授权：token 缺失或无效", status: 401 };
        throw e1;
      }
      return res.text().then(function (text) {
        var body = null;
        if (text) {
          try { body = JSON.parse(text); } catch (err2) { body = text; }
        }
        if (!res.ok) {
          var msg = (body && body.message) ? body.message : "HTTP " + res.status;
          throw { kind: "http", status: res.status, body: body, message: msg };
        }
        return body;
      });
    })
    .catch(function (e) {
      // fetch 抛出的 TypeError 为网络层失败；浏览器无法区分 DNS/TLS/隧道等原因，统一提示。
      if (e && e.kind) throw e;
      throw {
        kind: "network",
        message: "无法连接服务",
        detail: e ? String(e && (e.message || e)) : "",
      };
    });
}

/** 仅带鉴权头的 fetch（会话 SSE 流用：需手动读流，不能走 apiCall）。 */
function authedFetch(url) {
  var headers = {};
  var token = tokenEffective();
  if (token) headers["authorization"] = "Bearer " + token;
  return fetch(url, { method: "GET", headers: headers });
}

/**
 * 横幅：一行短句 + 可选一个动作按钮（如“重试”）。
 * 收敛原则：不再罗列原因清单；配对页（未授权入口）不用横幅，错误回卡片内。
 * @param {string} message 一行短句
 * @param {{label: string, fn: Function}=} action 动作按钮
 */
function showConnBanner(message, action) {
  // 多壳页面（会话页有列表/详情两个壳）同刷同隐；单壳页只有一个元素
  var banners = document.querySelectorAll(".conn-banner");
  Array.prototype.forEach.call(banners, function (banner) {
    clear(banner);
    banner.classList.remove("hidden");
    banner.appendChild(el("strong", message));
    if (action && action.label) {
      var b = el("button", action.label, "banner-action");
      b.type = "button";
      b.addEventListener("click", function () {
        banner.classList.add("hidden");
        clear(banner);
        if (action.fn) action.fn();
      });
      banner.appendChild(b);
    }
  });
}

function hideConnBanner() {
  var banners = document.querySelectorAll(".conn-banner");
  Array.prototype.forEach.call(banners, function (banner) {
    banner.classList.add("hidden");
  });
  clearReconnecting();
}

/**
 * 实时流断开时的“连接中断，正在恢复”提示：延迟 1 秒才显示——
 * 瞬断会被下一次成功的详情刷新立即清除，只有真的中断较久才打扰用户。
 */
var reconnectBannerTimer = null;
function showReconnecting() {
  if (reconnectBannerTimer) return;
  reconnectBannerTimer = window.setTimeout(function () {
    showConnBanner("连接中断，正在恢复…"); // 自动续传，无需用户操作
  }, 1000);
}
function clearReconnecting() {
  if (reconnectBannerTimer) { window.clearTimeout(reconnectBannerTimer); reconnectBannerTimer = null; }
}

function failWith(e) {
  if (e && e.kind === "unauthorized") {
    showConnBanner("口令失效，无法访问", {
      label: "重新连接",
      fn: function () { setToken(""); window.location.assign("/session.html"); },
    });
  } else {
    // 网络层失败：浏览器无法区分 DNS/TLS/隧道等原因；用户可整页重试
    showConnBanner("连接中断", { label: "重试", fn: function () { window.location.reload(); } });
  }
}

// ---------------- 提醒（声音 + 振动 + 系统通知 + 页内提示条） ----------------
// 三条通道各自可能不可用：逐项探测、如实报告。AudioContext 只在用户手势里创建
// （自动播放策略），并按需维持静音保活通道，避免后台标签页被冻结导致事件到不了页面。

var audioCtx = null;        // AudioContext：开启提醒后由用户手势创建
var keepAlive = null;       // { src, gain } 静音保活通道；关闭提醒时一并释放
var remindOn = false;       // 提醒总开关：关掉后振动也不响，不留任何通道
var remindLedger = makeRemindLedger(); // 本页生命周期的去重账本

/** 提醒去重账本：同一 key 只 take 一次（断线重连重放历史变更不会重复响）。 */
function makeRemindLedger() {
  var seen = {};
  return {
    take: function (key) { if (seen[key]) return false; seen[key] = true; return true; },
    size: function () { return Object.keys(seen).length; },
  };
}

/** 逐项探测真实能力。notif: unavailable | default | granted | denied。 */
function detectRemindCapabilities() {
  var caps = { sound: false, vibrate: false, notif: "unavailable", secure: true };
  try {
    if (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) caps.sound = true;
  } catch (e) { /* 无 WebAudio */ }
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") caps.vibrate = true;
  } catch (e) { /* 无振动 */ }
  try {
    if (typeof window.isSecureContext === "boolean") caps.secure = window.isSecureContext;
  } catch (e) { /* 老浏览器无该字段：按安全上下文处理 */ }
  if (caps.secure && typeof window !== "undefined" && "Notification" in window) {
    try { caps.notif = Notification.permission; } catch (e) { caps.notif = "denied"; }
  }
  return caps;
}

function keepAliveWanted() {
  try { return window.localStorage.getItem("agb_keepalive") !== "0"; } catch (e) { return true; }
}

/** 两声合成提示音（WebAudio，无音频文件、无请求）：上行 = 提问，下行 = 完成。 */
function playChime(kind) {
  if (!audioCtx) return;
  try {
    var freqs = kind === "question" ? [659.3, 880.0] : [880.0, 659.3];
    var now = audioCtx.currentTime;
    for (var i = 0; i < freqs.length; i++) {
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freqs[i];
      var t0 = now + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.2, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    }
  } catch (e) { /* 合成失败不阻塞提醒链路 */ }
}

/** 静音保活通道：循环静音缓冲维持音频流，避免后台标签页被冻结。 */
function startKeepAlive() {
  if (!audioCtx || keepAlive) return;
  try {
    var buf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    var g = audioCtx.createGain();
    g.gain.value = 0.0001; // 极低而非零：维持通道处于播放状态
    src.connect(g);
    g.connect(audioCtx.destination);
    src.start();
    keepAlive = { src: src, gain: g };
  } catch (e) {
    keepAlive = null;
  }
}

function stopKeepAlive() {
  if (!keepAlive) return;
  try { keepAlive.src.stop(); } catch (e) { /* 已停 */ }
  try { keepAlive.src.disconnect(); keepAlive.gain.disconnect(); } catch (e) { /* 已断 */ }
  keepAlive = null;
}

/** 开启提醒：必须在用户手势里调用（自动播放策略）。 */
function enableRemind() {
  var caps = detectRemindCapabilities();
  remindOn = true;
  if (caps.sound && !audioCtx) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      var p = audioCtx.resume();
      if (p && p.then) p.then(function () {}, function () {});
      if (keepAliveWanted()) startKeepAlive();
    } catch (e) {
      audioCtx = null;
    }
  }
  if (caps.notif === "default") requestNotify();
  previewRemind(); // 立刻试听 + 振动：让用户自己确认，不是"相信它应该会响"
  renderRemindRow();
}

/** 关闭提醒：停保活、关 AudioContext、振动也不再响——不留任何通道。 */
function disableRemind() {
  remindOn = false;
  stopKeepAlive();
  if (audioCtx) {
    try { audioCtx.close(); } catch (e) { /* 关闭失败忽略 */ }
    audioCtx = null;
  }
  renderRemindRow();
}

/** 提醒铃声（总闸关闭时啥也不做）：提问 = 上行两声 + 长振动；完成/失败 = 下行两声 + 短振动两次。 */
function ringRemind(kind) {
  if (!remindOn) return;
  playChime(kind === "question" ? "question" : "end");
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(kind === "question" ? 200 : [90, 60, 90]);
    }
  } catch (e) { /* 忽略 */ }
}

/** 试听：提问声 + 完成声 + 振动。 */
function previewRemind() {
  playChime("question");
  setTimeout(function () { playChime("end"); }, 650);
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([150, 120, 150]);
  } catch (e) { /* 忽略 */ }
}

function remindStatusText(caps) {
  var parts = [];
  parts.push(caps.sound ? "声音 ✓" : "声音 ✗（浏览器不支持 WebAudio）");
  parts.push(caps.vibrate ? "振动 ✓" : "振动 ✗（设备/浏览器不支持）");
  if (caps.notif === "granted") parts.push("系统通知 ✓");
  else if (caps.notif === "default") parts.push("系统通知：可开启");
  else if (caps.notif === "denied") parts.push("系统通知 ✗（权限被拒）");
  else parts.push("系统通知 ✗（要在锁屏弹通知需要加密连接 HTTPS，当前只在打开的页面里提醒）");
  return "提醒能力：" + parts.join(" · ");
}

/** 渲染提醒状态行 + 动作按钮（纯 textContent，能力逐项如实）。 */
function renderRemindRow() {
  var status = document.getElementById("notifyStatus");
  var actions = document.getElementById("notifyActions");
  if (!status || !actions) return;
  var caps = detectRemindCapabilities();
  clear(actions);
  var on = remindOn; // 总开关（纯振动设备无 AudioContext 也算开）
  if (!on) {
    var usable = caps.sound || caps.vibrate || caps.notif !== "unavailable";
    status.textContent = remindStatusText(caps);
    var b = el("button", usable ? "开启提醒" : "本环境无可用提醒通道", "link");
    b.type = "button";
    b.disabled = !usable;
    if (usable) b.addEventListener("click", function () { enableRemind(); });
    actions.appendChild(b);
    return;
  }
  status.textContent = keepAlive
    ? "提醒已开启 · 后台保活开（为在别的 App 前台时也能响，会保持一个静音音频通道，浏览器可能显示音频图标）"
    : "提醒已开启 · 后台保活关（仅确保本页前台时的提醒）";
  var b1 = el("button", "试听", "link");
  b1.type = "button";
  b1.addEventListener("click", function () { previewRemind(); });
  actions.appendChild(b1);
  var b2 = el("button", keepAlive ? "后台保活：开" : "后台保活：关", "link");
  b2.type = "button";
  b2.addEventListener("click", function () {
    try { window.localStorage.setItem("agb_keepalive", keepAlive ? "0" : "1"); } catch (e) { /* 隐私模式忽略 */ }
    if (keepAliveWanted()) startKeepAlive(); else stopKeepAlive();
    renderRemindRow();
  });
  actions.appendChild(b2);
  var b3 = el("button", "关闭提醒", "link");
  b3.type = "button";
  b3.addEventListener("click", function () { disableRemind(); });
  actions.appendChild(b3);
}

function requestNotify() {
  if (!("Notification" in window)) return;
  try {
    var p = Notification.requestPermission(function () { renderRemindRow(); });
    if (p && p.then) p.then(function () { renderRemindRow(); }, function () { renderRemindRow(); });
  } catch (e) {
    renderRemindRow();
  }
}

/** 系统通知仅在授权时发出；tag 相同会替换旧通知，重放历史不重复弹窗。 */
function pushNotify(title, body, tag) {
  if (!("Notification" in window)) return;
  try {
    if (Notification.permission !== "granted") return;
    var n = new Notification(title, { body: body, tag: tag });
    n.onclick = function () { window.focus(); n.close(); };
  } catch (e) { /* 非安全上下文禁用通知时静默失败，页内提示仍然有效 */ }
}

// ---------------- 页内提示条（提问/完成到达时镶在对话流顶部） ----------------

var alertBarTimer = null;

function showAlertBar(text, actionLabel, actionFn, kind) {
  var host = document.getElementById("chatFlow");
  if (!host) return;
  var bar = document.getElementById("alertBar");
  if (!bar) {
    bar = el("div", null, "alert-bar");
    bar.id = "alertBar";
    host.insertBefore(bar, host.firstChild);
  }
  clear(bar);
  bar.className = "alert-bar" + (kind ? " alert-bar-" + kind : "");
  bar.appendChild(el("strong", text, "alert-bar-text"));
  if (actionLabel && actionFn) {
    var b = el("button", actionLabel, "alert-bar-action link");
    b.type = "button";
    b.addEventListener("click", function () {
      hideAlertBar();
      actionFn();
    });
    bar.appendChild(b);
  }
  bar.classList.remove("hidden");
  if (alertBarTimer) { clearTimeout(alertBarTimer); alertBarTimer = null; }
  alertBarTimer = setTimeout(hideAlertBar, 20000);
}

function hideAlertBar() {
  if (alertBarTimer) { clearTimeout(alertBarTimer); alertBarTimer = null; }
  var bar = document.getElementById("alertBar");
  if (bar) bar.classList.add("hidden");
}

// ---------------- 工具页（二级页面：一次性任务端的正常分区） ----------------

/**
 * 工具页：列出全部端，按能力给出入口（任务表单 / 开始会话），能力与形态明确标注。
 * 主路径是「会话」页；这里是不支持连续对话的一次性任务端的成品分区。
 */
function loadToolsPage() {
  if (!tokenEffective()) {
    // 未授权统一回配对入口（配对成功后可再次进入）
    window.location.replace("/session.html");
    return;
  }
  var node = document.getElementById("toolsList");
  if (!node) return;
  clear(node);
  node.appendChild(loadingPlaceholder("card"));

  apiCall("/api/tools")
    .then(function (data) {
      hideConnBanner();
      clear(node);
      var tools = (data && data.tools) || [];
      if (tools.length === 0) {
        node.appendChild(emptyGuide("暂时没有可用的端"));
        return;
      }
      tools.forEach(function (tool) {
        var card = el("div", null, "card");
        card.appendChild(el("h3", tool.name));
        card.appendChild(el("p", tool.description, "muted"));
        var mode = tool.mode || "task";
        var caps = tool.capabilities || {};
        if (mode === "task" || mode === "both") {
          var btnForm = el("a", "打开表单", "btn");
          btnForm.href = "/form.html?tool=" + encodeURIComponent(tool.id);
          card.appendChild(btnForm);
        }
        if (mode === "session" || mode === "both") {
          var btnSess = el("button", "开始会话", "btn");
          btnSess.type = "button";
          btnSess.addEventListener("click", function () { startSession(tool.id, btnSess); });
          card.appendChild(btnSess);
        }
        // 不支持的能力明确标注，不留空按钮
        var parts = [];
        if (caps.sessions) parts.push("会话");
        if (caps.listSessions) parts.push("列出会话");
        if (caps.streaming) parts.push("流式输出");
        if (caps.askUser) parts.push("提问等待回答");
        if (parts.length > 0) {
          card.appendChild(el("p", "能力：" + parts.join(" · "), "muted"));
        } else {
          card.appendChild(el("p", "能力：一次性任务 · 不支持会话", "muted"));
        }
        node.appendChild(card);
      });
    })
    .catch(function (e) {
      failWith(e);
      clear(node);
      node.appendChild(emptyGuide("加载失败，请检查连接", "重试", function () { loadToolsPage(); }));
    });
}

// ---------------- 表单页 ----------------

function loadForm() {
  if (!tokenEffective()) {
    // 未授权统一回配对入口，不渲染表单与错误横幅
    window.location.replace("/session.html");
    return;
  }
  var params = new URLSearchParams(window.location.search);
  var toolId = params.get("tool") || "";
  var titleNode = document.getElementById("formTitle");
  var descNode = document.getElementById("formDesc");
  var formNode = document.getElementById("taskForm");
  var errorsNode = document.getElementById("formErrors");

  if (!toolId) {
    errorsNode.appendChild(el("p", "这个链接不完整，缺少必要的参数"));
    return;
  }

  apiCall("/api/tools")
    .then(function (data) {
      hideConnBanner();
      var tools = (data && data.tools) || [];
      var tool = tools.filter(function (t) { return t.id === toolId; })[0];
      if (!tool) {
        errorsNode.appendChild(el("p", "没找到这个工具（它可能已经被移除）"));
        // 原始工具编号收进折叠，排障时再看
        appendRawResultToggle(errorsNode, { toolId: toolId }, "查看工具编号");
        return;
      }
      titleNode.textContent = tool.name;
      descNode.textContent = tool.description;
      window.__formFields = tool.fields;
      buildForm(formNode, tool.fields);

      // 提交键：一次提交尝试内固定；网络失败重试复用同一键，避免重复执行。
      var keyHolder = { key: uuid() };
      formNode.addEventListener("submit", function (ev) {
        ev.preventDefault();
        submitForm(formNode, errorsNode, toolId, keyHolder);
      });
    })
    .catch(function (e) {
      failWith(e);
    });
}

function buildForm(formNode, fields) {
  fields.forEach(function (f) {
    var wrap = el("label", null, "field");
    wrap.appendChild(el("span", f.label + (f.required ? " *" : ""), "field-label"));
    var input;
    if (f.type === "select") {
      input = el("select");
      input.name = f.name;
      (f.options || []).forEach(function (opt) {
        var o = el("option", opt);
        o.value = opt;
        input.appendChild(o);
      });
    } else if (f.type === "textarea") {
      input = el("textarea");
      input.name = f.name;
      if (f.placeholder) input.placeholder = f.placeholder;
    } else if (f.type === "boolean") {
      input = el("input");
      input.type = "checkbox";
      input.name = f.name;
    } else {
      input = el("input");
      input.type = f.type === "number" ? "number" : "text";
      input.name = f.name;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    if (!f.required) input.dataset.optional = "1";
    wrap.appendChild(input);
    if (f.help) wrap.appendChild(el("span", f.help, "field-help muted"));
    formNode.appendChild(wrap);
  });
  var submit = el("button", "提交任务", "btn primary");
  submit.type = "submit";
  formNode.appendChild(submit);
}

function collectForm(formNode, fields) {
  var input = {};
  fields.forEach(function (f) {
    var node = formNode.elements.namedItem(f.name);
    if (!node) return;
    if (f.type === "boolean") {
      input[f.name] = node.checked;
    } else if (f.type === "number") {
      var raw = node.value;
      if (raw === "" || raw === null) {
        if (!f.required) input[f.name] = undefined;
        else input[f.name] = undefined;
        return;
      }
      var num = Number(raw);
      input[f.name] = Number.isFinite(num) ? num : raw;
    } else {
      if (node.value !== "" && node.value !== null) input[f.name] = node.value;
    }
  });
  return input;
}

function submitForm(formNode, errorsNode, toolId, keyHolder) {
  clear(errorsNode);
  var body = {
    toolId: toolId,
    idempotencyKey: keyHolder.key,
    input: {},
  };
  // 从表单元素收集原始值
  var fields = (window.__formFields || []);
  body.input = collectForm(formNode, fields);

  apiCall("/api/tasks", { method: "POST", body: JSON.stringify(body) })
    .then(function (res) {
      hideConnBanner();
      var task = res && res.task;
      if (task && task.id) {
        window.location.assign("/task.html?id=" + encodeURIComponent(task.id));
      } else {
        errorsNode.appendChild(el("p", "服务返回了意外的响应"));
      }
    })
    .catch(function (e) {
      if (e && e.kind === "http" && e.status === 409) {
        var existing = (e.body && e.body.existingTaskId) || "";
        errorsNode.appendChild(el("p", "同一个任务请求被用在了不同的内容上，请重新发起"));
        if (existing) {
          var link = el("a", "打开已存在任务", "btn");
          link.href = "/task.html?id=" + encodeURIComponent(existing);
          errorsNode.appendChild(link);
        }
        // 新冲突需要新提交键
        keyHolder.key = uuid();
      } else if (e && e.kind === "http" && e.status === 400) {
        var details = (e.body && e.body.details) || [];
        if (details && details.length) {
          details.forEach(function (d) {
            errorsNode.appendChild(el("p", (d.path || "") + ": " + d.message));
          });
        } else {
          errorsNode.appendChild(el("p", (e.body && e.body.message) || "输入不合法"));
        }
        keyHolder.key = uuid();
      } else if (e && e.kind === "unauthorized") {
        failWith(e);
        keyHolder.key = uuid(); // 重设 token 后需要新键？不：同参数同键仍幂等安全。保留旧键更优。
      } else {
        failWith(e);
        // 网络失败：保留同一提交键重试（顶部 banner 提示）。
      }
    });
}

// ---------------- 任务详情页 ----------------

var pollTimer = null;

function loadTaskPage() {
  if (!tokenEffective()) {
    // 未授权统一回配对入口，不渲染任务详情
    window.location.replace("/session.html");
    return;
  }
  var params = new URLSearchParams(window.location.search);
  var taskId = params.get("id") || "";
  var badge = document.getElementById("statusBadge");
  var resultBox = document.getElementById("resultBox");
  var errorBox = document.getElementById("errorBox");
  var eventList = document.getElementById("eventList");
  var timeoutNote = document.getElementById("timeoutNote");
  var idLine = document.getElementById("taskIdLine");
  var lastSeq = 0;

  if (!taskId) {
    idLine.textContent = "这个链接不完整，缺少必要的参数";
    return;
  }
  // 正文不裸露任务编号：先给一句人话，uuid 收进“查看任务编号”折叠（排障时再看）
  var idHuman = el("span", "任务读取中…", "task-id-human");
  idLine.appendChild(idHuman);
  appendRawResultToggle(idLine, { taskId: taskId }, "查看任务编号");

  function refresh() {
    apiCall("/api/tasks/" + encodeURIComponent(taskId) + "?sinceSeq=" + lastSeq)
      .then(function (data) {
        hideConnBanner();
        var task = data && data.task;
        var events = (data && data.events) || [];
        if (!task) return;
        if (task.createdAt) idHuman.textContent = "创建于 " + new Date(task.createdAt).toLocaleString();
        badge.textContent = STATUS_LABELS[task.status] || task.status;
        badge.className = "badge badge-" + task.status;

        if (task.timeoutMarkedAt && task.status === "running") {
          timeoutNote.classList.remove("hidden");
          timeoutNote.textContent =
            "已超过建议等待时间，仍未确认执行结束；任务不会因此被标记为失败，执行可能仍在进行。";
        }

        if (task.error) {
          errorBox.classList.remove("hidden");
          clear(errorBox);
          errorBox.appendChild(el("p", "失败原因：" + (task.error.message || "")));
          if (task.error.detail) {
            var pre = el("pre", task.error.detail);
            pre.className = "result";
            errorBox.appendChild(pre);
          }
        }

        if (task.result !== null && task.result !== undefined) {
          resultBox.textContent = JSON.stringify(task.result, null, 2);
        }

        events.forEach(function (ev) {
          var evClass = "event " + (EVENT_TYPE_CLASS[ev.type] || "");
          var li = el("li", null, evClass);
          li.appendChild(el("div", eventHead(ev), "muted"));
          li.appendChild(el("div", ev.message));
          eventList.appendChild(li);
          if (ev.seq > lastSeq) lastSeq = ev.seq;
        });

        if (["succeeded", "failed", "interrupted"].indexOf(task.status) >= 0) {
          if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
        }
      })
      .catch(function (e) {
        // 断网不代表任务失败：只提示连接，不清空已有内容。
        if (e && e.kind === "unauthorized") {
          failWith(e);
        } else if (e && e.kind === "http" && e.status === 404) {
          badge.textContent = "任务不存在";
          if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
        } else {
          failWith(e);
        }
      });
  }

  refresh();
  pollTimer = window.setInterval(refresh, 1500);
}

// ---------------- 启动 ----------------

function initTokenDialog() {
  var dialog = document.getElementById("tokenDialog");
  if (!dialog) return;
  // 多壳页面（会话页列表壳与聊天壳各有一个 Token 按钮）都开同一个对话框
  Array.prototype.forEach.call(document.querySelectorAll(".token-btn"), function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById("tokenInput");
      input.value = tokenEffective();
      if (typeof dialog.showModal === "function") dialog.showModal();
    });
  });
  dialog.addEventListener("close", function () {
    if (dialog.returnValue === "save") {
      var input = document.getElementById("tokenInput");
      setToken((input.value || "").trim());
      window.location.reload();
    }
  });
}

// ---------------- 主题（浅色 / 深色 / 跟随系统，持久化） ----------------

var THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
var THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };

function currentThemeMode() {
  var stored = null;
  try { stored = window.localStorage.getItem("agb_theme"); } catch (e) { stored = null; }
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  // 顶栏主题按钮已图标化：文字只进无障碍标签与提示，不占顶栏空间
  Array.prototype.forEach.call(document.querySelectorAll(".theme-btn"), function (b) {
    b.setAttribute("aria-label", "切换主题（当前：" + THEME_LABEL[mode] + "）");
    b.title = THEME_LABEL[mode];
  });
}

function initThemeButtons() {
  Array.prototype.forEach.call(document.querySelectorAll(".theme-btn"), function (b) {
    b.addEventListener("click", function () {
      var next = THEME_NEXT[currentThemeMode()];
      try { window.localStorage.setItem("agb_theme", next); } catch (e) { /* 隐私模式：仅本次会话生效 */ }
      applyTheme(next);
    });
  });
  applyTheme(currentThemeMode());
}

// ---------------- 会话（第二层） ----------------

var TURN_LABELS = {
  pending: "等待执行",
  streaming: "仍在输出",
  awaiting_answer: "等待你的回答",
  answered: "已回答，继续执行",
  succeeded: "完成",
  failed: "失败",
  interrupted: "中断（结果未知）",
};

var TERMINAL_TURN_KEYS = ["succeeded", "failed", "interrupted"];

/** 创建会话（点击触发，避免页面重载重复创建）。 */
function startSession(toolId, btn) {
  btn.disabled = true;
  btn.textContent = "正在创建会话…";
  apiCall("/api/sessions", { method: "POST", body: JSON.stringify({ toolId: toolId }) })
    .then(function (data) {
      hideConnBanner();
      var s = data && data.session;
      if (s && s.id) {
        window.location.assign("/session.html?id=" + encodeURIComponent(s.id));
      } else {
        btn.disabled = false;
        btn.textContent = "开始会话";
      }
    })
    .catch(function (e) {
      btn.disabled = false;
      btn.textContent = "开始会话";
      if (e && e.kind === "http" && e.status === 409) {
        showConnBanner("该端不支持会话");
      } else {
        failWith(e);
      }
    });
}

var sessionPollTimer = null;
var sessionStreamCancel = null;

/** 会话页入口：未授权先配对卡；有 id 显示会话详情（SSE 优先，轮询回退），无 id 显示列表。 */
function loadSessionPage() {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get("id") || "";
  if (!tokenEffective()) {
    showPairingView();
    return;
  }
  if (!sessionId) {
    loadSessionListView();
    return;
  }
  loadSessionDetailView(sessionId);
}

// ---------- 配对视图（未授权时的唯一入口：列表/表单/横幅均不渲染） ----------

var pairingBound = false;

/**
 * 配对卡：未授权时占据整个主内容区。口令只经请求头发一次只读请求验证；
 * 失败提示回卡片内（短句），不走顶部横幅。
 */
function showPairingView() {
  var pairing = document.getElementById("pairingView");
  if (!pairing) return; // 非 session 页没有配对卡标记：未授权仍由各页 failWith 处理
  var listView = document.getElementById("sessionListView");
  if (listView) listView.classList.add("hidden");
  var detailView = document.getElementById("sessionDetailView");
  if (detailView) detailView.classList.add("hidden");
  var form = document.getElementById("pairingForm");
  var input = document.getElementById("pairingInput");
  if (!form || !input) return;
  pairing.classList.remove("hidden");
  try { input.focus(); } catch (e) { /* 部分浏览器拒绝自动聚焦 */ }

  if (pairingBound) return;
  pairingBound = true;
  var errBox = document.getElementById("pairingError");
  var btn = document.getElementById("pairingBtn");

  function setError(text) {
    if (!errBox) return;
    if (text) {
      errBox.textContent = text;
      errBox.classList.remove("hidden");
    } else {
      errBox.textContent = "";
      errBox.classList.add("hidden");
    }
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var cand = (input.value || "").trim();
    if (!cand) {
      setError("请输入访问口令");
      return;
    }
    setError("");
    btn.disabled = true;
    btn.textContent = "连接中…";
    setToken(cand);
    apiCall("/api/tools")
      .then(function () {
        hideConnBanner();
        hidePairingAndLoad();
      })
      .catch(function (e) {
        setToken(""); // 无效口令不留存：重载回到干净的配对卡
        btn.disabled = false;
        btn.textContent = "连接";
        if (e && e.kind === "unauthorized") setError("口令不对，请重试");
        else if (e && e.kind === "network") setError("连接不上电脑端");
        else setError("连接失败，请重试");
      });
  });
}

/** 配对成功：收起配对卡，按 URL 决定进列表还是详情（无横幅直出）。 */
function hidePairingAndLoad() {
  var pairing = document.getElementById("pairingView");
  if (pairing) pairing.classList.add("hidden");
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get("id") || "";
  if (sessionId) loadSessionDetailView(sessionId);
  else loadSessionListView();
}

// ---------- 会话列表视图 ----------

var listViewBound = false;
function loadSessionListView() {
  var listNode = document.getElementById("sessionsList");
  var form = document.getElementById("newSessionForm");
  var select = document.getElementById("newSessionTool");
  var hint = document.getElementById("newSessionHint");
  var toolDesc = document.getElementById("newSessionToolDesc");
  var btn = document.getElementById("newSessionBtn");
  var knownTools = [];

  /** 选中端的说明 + 能力一览（让用户在创建前看清该端支持什么、限制是什么）。 */
  function updateToolDesc(tools) {
    if (!toolDesc) return;
    var t = tools.filter(function (x) { return x.id === select.value; })[0];
    if (!t) { toolDesc.textContent = ""; return; }
    var caps = t.capabilities || {};
    var parts = [];
    if (caps.streaming) parts.push("流式输出");
    if (caps.askUser) parts.push("可向你提问");
    if (caps.listSessions) parts.push("可列会话");
    if (!parts.length) parts.push("无会话能力");
    toolDesc.textContent = (t.description || "") + "（" + parts.join(" · ") + "）";
  }

  document.getElementById("sessionListView").classList.remove("hidden");
  var detail = document.getElementById("sessionDetailView");
  if (detail) detail.classList.add("hidden");
  var toList = document.getElementById("toListLink");
  if (toList) toList.classList.add("hidden");

  loadSessionListInto(listNode);

  apiCall("/api/tools")
    .then(function (data) {
      hideConnBanner();
      var tools = ((data && data.tools) || []).filter(function (t) {
        return (t.mode === "session" || t.mode === "both") && t.capabilities && t.capabilities.sessions;
      });
      clear(select);
      if (tools.length === 0) {
        if (hint) {
          hint.textContent = "暂时没有可以会话的端。";
          hint.classList.remove("hidden");
        }
        if (btn) btn.disabled = true;
        return;
      }
      tools.forEach(function (t) {
        var o = el("option", t.name);
        o.value = t.id;
        select.appendChild(o);
      });
      knownTools = tools;
      updateToolDesc(tools);
      select.addEventListener("change", function () { updateToolDesc(knownTools); });
    })
    .catch(function (e) {
      failWith(e);
    });

  // 守卫：配对成功后可能再次进入列表视图，表单只绑一次，避免重复提交
  if (!listViewBound) {
    listViewBound = true;
    form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var toolId = select.value;
    if (!toolId) return;
    btn.disabled = true;
    btn.textContent = "正在创建…";
    apiCall("/api/sessions", { method: "POST", body: JSON.stringify({ toolId: toolId }) })
      .then(function (data) {
        hideConnBanner();
        var s = data && data.session;
        if (s && s.id) {
          window.location.assign("/session.html?id=" + encodeURIComponent(s.id));
        } else {
          btn.disabled = false;
          btn.textContent = "创建会话";
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = "创建会话";
        if (e && e.kind === "http" && e.status === 409) {
          showConnBanner("该端不支持会话");
        } else {
          failWith(e);
        }
      });
  });
  }
}

/**
 * 会话行（iOS 分组列表风格）：头像位取端名首字、预览末轮消息、右箭头。
 * 显示名优先取端清单里的 name，取不到才回退 toolId（用户界面不出现原始 id）。
 */
function renderSessionRow(host, s, names) {
  var row = el("a", null, "srow enter");
  row.href = "/session.html?id=" + encodeURIComponent(s.id);
  var displayName = (names && names[s.toolId]) || s.toolId || "?";
  var initial = displayName.slice(0, 1).toUpperCase();
  row.appendChild(el("span", initial, "avatar"));
  var body = el("div", null, "srow-body");
  var preview = s.lastTurnMessage ? "“" + s.lastTurnMessage + "”" : "（尚无消息）";
  body.appendChild(el("div", preview, "srow-title")); // CSS 单行省略：长消息不再撑高行
  var meta = displayName + " · " + relTime(s.lastTurnAt || s.createdAt) + " · " + s.turnCount + " 轮";
  body.appendChild(el("div", meta, "srow-meta"));
  row.appendChild(body);
  var badgeStatus = s.lastTurnStatus || "pending";
  row.appendChild(el("span", TURN_LABELS[badgeStatus] || badgeStatus, "badge badge-" + badgeStatus));
  row.appendChild(el("span", "›", "chevron"));
  host.appendChild(row);
}

/**
 * 会话列表：先取端清单（显示名映射，列表行不出现原始 id），再列最近会话。
 */
function loadSessionListInto(node) {
  clear(node);
  node.appendChild(loadingPlaceholder("list")); // 加载态：骨架屏 3 条灰块，不用“正在加载…”长驻文本
  apiCall("/api/tools")
    .then(function (toolsData) {
      var names = {};
      ((toolsData && toolsData.tools) || []).forEach(function (t) {
        if (t && t.id) names[t.id] = t.name;
      });
      return apiCall("/api/sessions?limit=20").then(function (data) { return { names: names, data: data }; });
    })
    .then(function (res) {
      hideConnBanner();
      clear(node);
      var sessions = (res.data && res.data.sessions) || [];
      if (sessions.length === 0) {
        // 空态：居中一句引导 + 创建动作（滚到新建表单并聚焦）
        node.appendChild(emptyGuide("还没有会话", "创建第一个会话", function () {
          var select = document.getElementById("newSessionTool");
          var card = document.getElementById("newSessionForm");
          if (select && card) {
            card.scrollIntoView({ behavior: "smooth", block: "center" });
            try { select.focus(); } catch (e) { /* focus 可能被浏览器拒绝 */ }
          } else {
            window.location.assign("/session.html");
          }
        }));
        return;
      }
      sessions.forEach(function (s) { renderSessionRow(node, s, res.names); });
    })
    .catch(function (e) {
      failWith(e);
      clear(node); // 失败时清掉 spinner，错误提示由横幅承载
    });
}

// ---------- 会话详情视图（手机聊天 App 壳：顶栏常驻 / 气泡对话流 / 贴底滚动 / 输入条固定底部） ----------

function loadSessionDetailView(sessionId) {
  var listView = document.getElementById("sessionListView");
  if (listView) listView.classList.add("hidden");
  document.getElementById("sessionDetailView").classList.remove("hidden");

  var chatTitle = document.getElementById("chatTitle");
  var sessionMeta = document.getElementById("sessionMeta");
  var badge = document.getElementById("turnBadge");
  var chatScroll = document.getElementById("chatScroll");
  var chatFlow = document.getElementById("chatFlow");
  var msgForm = document.getElementById("msgForm");
  var sendBtn = document.getElementById("sendBtn");
  var streamSeq = 0; // SSE 游标（/stream?sinceSeq=）：只由服务端流数据推进，REST/缓存不推进
  var renderedEventKeys = {}; // 事件去重集合：key=(turnId|taskId)|seq——两个来源的事件集不同，不能用单一水位跨来源去重
  var cumulativeEvents = []; // 本页生命周期内实际渲染的事件合并集（缓存写入用，无损：真实渲染集而非“最后一份快照”）
  var seenStatuses = {}; // turnId → 上次见到的状态；只对变化发通知
  var snapshotSeen = false; // 首次快照（页面打开时已是历史）不弹通知
  var originalTitle = document.title;
  var answering = false; // 本地防重复点击；服务端另有幂等保证
  var answeringTurnId = null;
  var stickToBottom = true; // 贴底滚动：用户上滑离开底部后停止跟随
  var turnBlocks = {}; // turnId → { block, aiCol, sepBadge, ask*, outcome*, typing }
  var toolNames = {}; // 端显示名（顶栏标题）；取不到就回退显示 toolId
  var shownToolId = ""; // 当前快照的端 id（AI 头像首字用；端名晚到时后续新气泡自动用上显示名）

  renderRemindRow();

  apiCall("/api/tools")
    .then(function (data) {
      ((data && data.tools) || []).forEach(function (t) {
        if (t && t.id) toolNames[t.id] = t.name;
      });
      // 端名可能晚于首个快照到达：重刷一次，顶栏标题与事件列表从原始 id 变为显示名
      refresh();
    })
    .catch(function () { /* 取不到名字就回退显示 id */ });

  function setMeta(text) {
    sessionMeta.textContent = text || "";
    if (text) sessionMeta.classList.remove("hidden");
    else sessionMeta.classList.add("hidden");
  }

  // ---- 贴底滚动：scroll 事件判定是否在底部附近（阈值 60px）；程序滚动也会触发并自洽 ----
  function isNearBottom() {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight <= 60;
  }
  chatScroll.addEventListener("scroll", function () {
    stickToBottom = isNearBottom();
  });
  function scrollToBottom() { chatScroll.scrollTop = chatScroll.scrollHeight; }
  function maybeAutoScroll() { if (stickToBottom) scrollToBottom(); }

  var emptyHint = el("div", "发一条消息开始对话", "empty-hint");

  // ---- 轮次块：分隔（第 N 轮 + 状态徽标）+ 用户气泡（靠右）+ 端侧列（靠左） ----
  function createTurnBlock(t, index) {
    var block = el("div", null, "turn-block");
    var sep = el("div", null, "turn-sep");
    var pill = el("div", null, "turn-sep-pill");
    pill.appendChild(el("span", "第 " + index + " 轮", "turn-sep-label"));
    var sepBadge = el("span", null, "badge");
    pill.appendChild(sepBadge);
    sep.appendChild(pill);
    block.appendChild(sep);
    var userRow = el("div", null, "msg user enter");
    userRow.appendChild(el("span", "我", "chat-avatar user"));
    userRow.appendChild(el("div", t.message, "bubble user-bubble"));
    block.appendChild(userRow);
    var aiCol = el("div", null, "ai-col");
    block.appendChild(aiCol);
    chatFlow.appendChild(block);
    return {
      block: block,
      aiCol: aiCol,
      badge: sepBadge,
      askKey: null,
      askCard: null,
      outcomeKey: null,
      outcomeCard: null,
      typing: null,
      tray: null,
    };
  }

  /** AI 头像首字：端显示名首字符（拿不到显示名先用 tool id，再不行用 "AI"）；纯 DOM 文本，无图片资源。 */
  function avatarInitial() {
    var name = toolNames[shownToolId] || shownToolId || "AI";
    return name.slice(0, 1).toUpperCase();
  }
  /**
   * 事件落块：按分类决定形态——回答正文=对话气泡（无日志式头）；过程事件=收起抽屉；
   * 提醒/系统注意项=带标签的可见气泡（绝不能藏）。
   */
  function appendEventBubble(rec, ev) {
    var kind = classifyEvent(ev);
    if (kind === "process") {
      appendProcessLine(rec, ev);
      return;
    }
    var row = el("div", null, "msg ai enter");
    row.appendChild(el("span", avatarInitial(), "chat-avatar ai"));
    var bubble = el("div", null, "bubble ai-bubble" + (kind === "attention" ? " bubble-attention" : ""));
    if (kind === "attention") {
      // 提醒/系统注意项保留一眼可辨的小标签（不含时间戳日志头）
      bubble.appendChild(el("div", ev.type === "warning" ? "提醒" : "系统", "bubble-kind"));
    }
    var text = ev.message;
    if (ev.percent !== null && ev.percent !== undefined) text += "（" + ev.percent + "%）";
    var body = el("div", null, "bubble-text");
    if (kind === "attention") {
      body.textContent = text; // 提醒/系统注意项保持纯文本
    } else {
      renderMarkdownInto(body, text); // 回答正文：安全 Markdown（纯 DOM 构造）
    }
    bubble.appendChild(body);
    row.appendChild(bubble);
    rec.aiCol.appendChild(row);
    // 同轮回答正文登记：结果卡去重用（结果卡再遇到同一文本时只留短状态 + 折叠原始结果）
    if (kind === "answer") {
      rec.renderedAnswers = rec.renderedAnswers || {};
      rec.renderedAnswers[text] = true;
    }
  }

  /** 过程事件：收进轮次级“过程 · N 条”抽屉（点击展开，纯 textContent 渲染）。 */
  function appendProcessLine(rec, ev) {
    if (!rec.tray) {
      var tray = el("div", null, "ev-tray enter");
      var state = { count: 0, expanded: false };
      var toggle = el("button", null, "ev-tray-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      var lines = el("div", null, "ev-tray-lines hidden");
      toggle.addEventListener("click", function () {
        state.expanded = !state.expanded;
        lines.classList.toggle("hidden", !state.expanded);
        toggle.textContent = trayLabel(state.count, state.expanded);
        toggle.setAttribute("aria-expanded", state.expanded ? "true" : "false");
      });
      tray.appendChild(toggle);
      tray.appendChild(lines);
      rec.tray = { node: tray, toggle: toggle, lines: lines, state: state };
      rec.aiCol.appendChild(tray);
    }
    rec.tray.state.count += 1;
    var label = EVENT_TYPE_LABELS[ev.type] || ev.type;
    var line = el("div", label + " · " + new Date(ev.createdAt).toLocaleTimeString() + " · " + ev.message, "ev-tray-line");
    rec.tray.lines.appendChild(line);
    rec.tray.toggle.textContent = trayLabel(rec.tray.state.count, rec.tray.state.expanded);
  }

  // ---- 提问卡（镶入对话流）：等待回答时给选项按钮；已回答则锁定显示已选答案，不能重复点 ----
  function renderAskCard(rec, t) {
    var hasAnswer = t.answer !== null && t.answer !== undefined;
    var key = "q|" + (t.pendingQuestion ? JSON.stringify([t.pendingQuestion.prompt, t.pendingQuestion.options]) : "-")
      + "|a:" + String(t.answer) + "|s:" + t.status
      + "|busy:" + (answeringTurnId === t.id ? "1" : "0");
    if (key === rec.askKey) return;
    rec.askKey = key;
    if (rec.askCard) { rec.askCard.remove(); rec.askCard = null; }
    // store 在回答/终态后会清除 pendingQuestion（问题瞬态、answer 持久）：
    // 提问本身不可见时，仅以“已回答：X”呈现该轮的回答，不渲染问题与选项
    if (!t.pendingQuestion) {
      if (hasAnswer) {
        var chip = el("div", null, "ask-card answered enter");
        chip.appendChild(el("span", "✓", "ask-check"));
        chip.appendChild(el("div", "已回答：" + t.answer, "ask-answered"));
        rec.askCard = chip;
        rec.aiCol.appendChild(chip);
      }
      return;
    }
    var card = el("div", null, "ask-card enter");
    if (hasAnswer) {
      card.classList.add("answered");
      card.appendChild(el("span", "✓", "ask-check"));
      card.appendChild(el("div", "已回答：" + t.answer, "ask-answered"));
    } else if (t.status === "awaiting_answer") {
      card.appendChild(el("p", t.pendingQuestion.prompt, "ask-prompt"));
      var btns = el("div", null, "ask-options");
      t.pendingQuestion.options.forEach(function (opt) {
        var b = el("button", opt, "btn");
        b.type = "button";
        if (answeringTurnId === t.id) b.disabled = true;
        b.addEventListener("click", function () { submitAnswer(t.id, opt, btns); });
        btns.appendChild(b);
      });
      card.appendChild(btns);
    } else {
      card.appendChild(el("p", t.pendingQuestion.prompt, "ask-prompt"));
      card.appendChild(el("div", "等待回答…", "muted"));
    }
    rec.askCard = card;
    rec.aiCol.appendChild(card);
  }

  // ---- 结果卡 / 失败卡：终态镶入对话流（失败红色可辨识，带原因与阶段） ----
  function renderOutcomeCard(rec, t) {
    var key = "";
    if (t.error) key = "error|" + (t.error.message || "") + "|" + (t.error.stage || "");
    else if (t.result !== null && t.result !== undefined) key = "result|" + JSON.stringify(t.result);
    if (key === rec.outcomeKey) return;
    rec.outcomeKey = key;
    if (rec.outcomeCard) { rec.outcomeCard.remove(); rec.outcomeCard = null; }
    if (!key) return;
    var card;
    if (t.error) {
      card = el("div", null, "error-card enter");
      card.appendChild(el("div", "轮次失败", "error-card-title"));
      card.appendChild(el("div", "原因：" + (t.error.message || "（未提供原因）"), "error-card-msg"));
      var stageLine = humanStage(t.error.stage);
      if (stageLine) card.appendChild(el("div", stageLine, "error-card-stage muted")); // 人话主文案
      // 技术代号与原始错误对象收进折叠详情（不当主文案）
      appendRawResultToggle(card, t.error, "查看技术细节");
    } else {
      card = el("div", null, "result-card enter");
      card.appendChild(el("div", "结果", "result-card-head")); // 结果标签（R8 重写时被误删，R12 补回；测试钉住此行）
      // 保守实现：结果对象直接含可阅读字段（summary/message/text/assistantText 的非空字符串）时，
      // 优先把该字段当正文渲染（支持 Markdown），原始 JSON 收进可展开的“查看原始结果”；
      // 任何拿不准的结构都不直出 JSON，一律收进折叠（R13：此前 pre.code 默认可见，与回答重复且不可读）。
      var readable = readableResultText(t.result);
      var dup = isAnswerAlreadyRendered(rec, readable);
      if (readable !== null && !dup) {
        var body = el("div", null, "result-text");
        renderMarkdownInto(body, readable);
        card.appendChild(body);
        appendRawResultToggle(card, t.result);
      } else if (dup) {
        // 同一段正文已作为本轮 AI 气泡渲染过：结果卡只留一行短状态 + 可展开的原始结果（不重复正文）
        card.appendChild(el("div", "本轮正文已在上方消息中", "result-text"));
        appendRawResultToggle(card, t.result);
      } else {
        // 无可读字段：原始 JSON 默认收起（不再可见直出）
        appendRawResultToggle(card, t.result);
      }
    }
    rec.outcomeCard = card;
    rec.aiCol.appendChild(card);
  }

  // ---- 打字指示器：focus 轮次仍在输出/处理中时显示；等待回答与终态时隐藏 ----
  function renderTyping(rec, t, isFocus) {
    var show = !!isFocus && ["pending", "streaming", "answered"].indexOf(t.status) >= 0;
    if (show && !rec.typing) {
      var typing = el("div", null, "typing enter");
      typing.appendChild(el("i"));
      typing.appendChild(el("i"));
      typing.appendChild(el("i"));
      rec.aiCol.appendChild(typing);
      rec.typing = typing;
    } else if (!show && rec.typing) {
      rec.typing.remove();
      rec.typing = null;
    } else if (show && rec.typing) {
      rec.aiCol.appendChild(rec.typing); // 保持指示器在端侧列末尾（新气泡之后）
    }
  }

  /** 统一渲染：GET 详情与 SSE hello/change 共用同一份快照形状。opts.fromCache=true 表示本次为本地缓存回放。 */
  function applySnapshot(data, opts) {
    var session = data && data.session;
    if (!session) return;
    if (loadingNode) { try { loadingNode.remove(); } catch (e2) { /* 节点已不在 DOM 中 */ } loadingNode = null; }
    if (!(opts && opts.fromCache)) cacheApplied = false; // 服务器快照已到达并渲染：后续断线不再按“缓存内容”提示
    chatTitle.textContent = toolNames[session.toolId] || session.toolId;
    shownToolId = session.toolId || shownToolId;
    // 实时流被降级为兼容连接时，副标题显示降级提示
    setMeta(streamDemoted ? "兼容连接（实时通道不可用）" : "");

    var turns = (data && data.turns) || [];
    var live = null;
    var last = null;
    turns.forEach(function (t) {
      if (t.id === data.liveTurnId) live = t;
      if (t.id === data.lastTurnId) last = t;
    });
    var focus = live || last;

    // 历史轮次与当前轮次统一并入对话流，按时间顺序渲染（不再分“当前/历史”两节）
    turns.forEach(function (t, idx) {
      var rec = turnBlocks[t.id];
      if (!rec) { rec = createTurnBlock(t, idx + 1); turnBlocks[t.id] = rec; }
      rec.badge.textContent = TURN_LABELS[t.status] || t.status;
      rec.badge.className = "badge badge-" + t.status;
    });

    if (turns.length === 0) {
      if (!emptyHint.parentNode) chatFlow.appendChild(emptyHint);
    } else if (emptyHint.parentNode) {
      emptyHint.remove();
    }

    // 顶栏徽标：当前轮次状态（无活跃轮次=空闲）
    if (!focus) {
      badge.textContent = "空闲";
      badge.className = "badge";
    } else {
      badge.textContent = TURN_LABELS[focus.status] || focus.status;
      badge.className = "badge badge-" + focus.status;
    }
    // 事件落块与去重（修复：两个来源的事件集不同——GET 详情只含 focus 轮次的 taskId 事件，
    // SSE hello/change 含 sinceSeq 之后的会话级 turnId 事件。不能用单一单调水位跨来源去重，
    // 否则先到的那份会把后到的整份跳过、永久丢历史事件）。
    // 去重按 (turnId|taskId, seq) 的已渲染集合：已渲染的跳过，缺的补上，绝不重复追加。
    // 事件必须进“自己轮次”的块；找不到归属块（轮次超出快照窗口）则丢弃——绝不混入别的轮次。
    var events = (data && data.events) || [];
    var appended = [];
    events.forEach(function (ev) {
      var key = eventDedupeKey(ev);
      if (renderedEventKeys[key]) return;
      var tid = ev.turnId || ev.taskId;
      var rec = tid ? turnBlocks[tid] : null;
      if (!rec && focus && (!tid || tid === focus.id)) rec = turnBlocks[focus.id];
      if (!rec) return;
      renderedEventKeys[key] = true;
      appendEventBubble(rec, ev);
      appended.push(ev);
    });
    // 缓存写入要无损：合并到本页累积集（真实渲染集），而非“最后一份快照”
    if (appended.length > 0) {
      cumulativeEvents = mergeEventLists([cumulativeEvents, appended]);
    }

    turns.forEach(function (t) {
      var rec = turnBlocks[t.id];
      renderAskCard(rec, t);
      renderOutcomeCard(rec, t);
      renderTyping(rec, t, focus && t.id === focus.id);
    });

    maybeAutoScroll();

    // 通知：仅首页快照之后的状态变化弹出（tag 去重，重放历史不重复弹窗）
    turns.forEach(function (t) {
      var prev = seenStatuses[t.id];
      if (prev === t.status) return;
      if (snapshotSeen) {
        if (t.status === "awaiting_answer") {
          notifyQuestion(t);
        } else if (TERMINAL_TURN_KEYS.indexOf(t.status) >= 0) {
          notifyEnd(t);
        }
      }
      seenStatuses[t.id] = t.status;
    });
    snapshotSeen = true;

    // 标题徽标：等待回答时醒目提示（页面切到后台也能在标签页看到）
    if (live && live.status === "awaiting_answer") {
      document.title = "【待回答】" + originalTitle;
    } else {
      document.title = originalTitle;
    }
    // 本地缓存：写入本页实际渲染的事件合并集（防抖；只存会话内容，不含 token；schema 版本号用于跨版本失效）。
    // 不写“最后一份快照的 events”——两个来源事件集不同，那样会有损（丢历史事件）
    writeSessionCache(sessionId, {
      session: session,
      turns: turns,
      liveTurnId: data.liveTurnId || null,
      lastTurnId: data.lastTurnId || null,
      events: cumulativeEvents,
    });
  }

  function notifyQuestion(turn) {
    var prompt = (turn.pendingQuestion && turn.pendingQuestion.prompt) || "端在等待你的回答";
    // 去重：同一提问只提醒一次（断线重连重放历史不会重复响）
    if (remindLedger.take("q|" + turn.id + "|" + prompt)) ringRemind("question");
    pushNotify("需要你的回答", prompt, "q-" + turn.id);
    showAlertBar("收到提问：" + prompt, "查看提问", function () {
      var card = document.querySelector(".ask-card");
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash");
        setTimeout(function () { card.classList.remove("flash"); }, 1600);
      }
    }, "question");
  }

  function notifyEnd(turn) {
    var label = TURN_LABELS[turn.status] || turn.status;
    if (remindLedger.take("e|" + turn.id + "|" + turn.status)) ringRemind(turn.status === "failed" ? "fail" : "end");
    pushNotify("轮次已" + label, "“" + turn.message + "”", "e-" + turn.id);
    showAlertBar("轮次已" + label, "查看结果", function () {
      var card = document.querySelector(".error-card") || document.querySelector(".result-card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }, turn.status === "failed" ? "error" : "end");
  }

  function refresh() {
    apiCall("/api/sessions/" + encodeURIComponent(sessionId))
      .then(function (data) {
        hideConnBanner();
        var session = data && data.session;
        if (!session) return;
        var live = (data && data.liveTurn) || (data && data.lastTurn);
        var mapped = {
          session: data.session,
          turns: (data && data.turns) || [],
          liveTurnId: data.liveTurn ? data.liveTurn.id : null,
          lastTurnId: data.lastTurn ? data.lastTurn.id : null,
          events: live ? (live.events || []) : [],
        };
        applySnapshot(mapped);
      })
      .catch(function (e) {
        // 断网不代表轮次失败：只提示连接，不清空已有气泡
        if (e && e.kind === "unauthorized") {
          failWith(e);
        } else if (e && e.kind === "http" && e.status === 404) {
          badge.textContent = "会话不存在";
          stopPolling();
          stopStream();
        } else if (cacheApplied) {
          // 离线/断线且当前显示的是缓存内容：如实标注，不清屏；服务器数据到达后自动清除
          showConnBanner("离线，显示的是上次内容");
        } else {
          failWith(e);
        }
      });
  }

  // ---------- SSE 流（持续输出与状态变更的实时推送；断线自动重连） ----------

  function startStream() {
    if (streamDemoted) { startPolling(); return; } // 已降级：固定轮询
    var url = "/api/sessions/" + encodeURIComponent(sessionId) + "/stream?sinceSeq=" + streamSeq;
    authedFetch(url)
      .then(function (resp) {
        if (!resp.ok) {
          if (resp.status === 401) {
            failWith({ kind: "unauthorized", message: "未授权：token 缺失或无效", status: 401 });
            return;
          }
          if (resp.status === 404) {
            badge.textContent = "会话不存在";
            stopPolling();
            return;
          }
          throw { kind: "http", status: resp.status };
        }
        hideConnBanner();
        stopPolling(); // 流连接健康时停止轮询；断开后再恢复
        var reader = resp.body.getReader();
        var decoder = new TextDecoder("utf-8");
        var buffer = "";
        var cancelled = false;
        // 看门狗：任何字节（含心跳注释行）长期不到即视为静默挂起——取消本连接并走回退重连，
        // 避免坏网络/中间代理上“无错误也无数据”的连接永远占着资源（服务端心跳 20s，看门狗 30s）。
        var WATCHDOG_MS = 30000;
        var watchdog = null;
        function armWatchdog() {
          if (watchdog) window.clearTimeout(watchdog);
          watchdog = window.setTimeout(function () {
            if (cancelled) return;
            try { reader.cancel(); } catch (e) { /* 忽略 */ }
            onStreamEnd();
          }, WATCHDOG_MS);
        }
        sessionStreamCancel = function () {
          cancelled = true;
          if (watchdog) { window.clearTimeout(watchdog); watchdog = null; }
          try { reader.cancel(); } catch (e) { /* 忽略 */ }
        };
        function pump() {
          if (cancelled) return;
          reader.read().then(function (chunk) {
            if (chunk.done) { onStreamEnd(); return; }
            buffer += decoder.decode(chunk.value, { stream: true });
            var frames = buffer.split("\n\n");
            buffer = frames.pop();
            for (var i = 0; i < frames.length; i++) handleStreamFrame(frames[i]);
            armWatchdog(); // 收到任意字节即续期
            // 首个字节到达即做一次并发请求能力探测（见 probeStreamSupport）：
            // 个别网络环境（桥接/代理）会独占长连接，把后续 fetch 全部挂起——
            // 那是“能收流但发不出消息”的致命模式，探测失败则降级为纯轮询。
            if (!streamProbed) { streamProbed = true; probeStreamSupport(); }
            pump();
          }).catch(function (e) {
            // 读循环里的任何异常（含渲染回调抛错）都会落到这里：留下证据再恢复，避免无声重连循环
            try { window.console.warn("会话流读循环异常：" + (e && (e.message || String(e)))); } catch (err2) { /* 记录也失败则放弃 */ }
            onStreamEnd();
          });
        }
        armWatchdog();
        pump();
      })
      .catch(function (e) {
        // 传输层不可用 ≠ 会话状态丢失：GET 会话详情是权威视图，轮询兜底
        onStreamEnd();
      });
  }

  function handleStreamFrame(frame) {
    var lines = frame.split("\n");
    var eventName = "message";
    var dataLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.slice(0, 1) === ":") continue; // 注释行（心跳）
      if (line.slice(0, 6) === "event:") {
        eventName = line.slice(6).trim();
      } else if (line.slice(0, 5) === "data:") {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (eventName !== "hello" && eventName !== "change") return;
    try {
      var snap = JSON.parse(dataLines.join("\n"));
      applySnapshot(snap);
      // SSE 游标只由服务端流数据推进：hello/change 的 events 是 sinceSeq 之后的增量，
      // 推进到本次流数据的最大 seq，断线重连时从此处续传（缓存与 REST 渲染不推进它，
      // 否则 REST 的部分事件会把服务端的全量重放挡在门外）
      var streamMax = maxEventSeq(snap && snap.events);
      if (streamMax > streamSeq) streamSeq = streamMax;
    } catch (e) {
      // 坏帧不中断流，但留痕：持久层是权威来源，下一帧/重连会自愈
      try { window.console.warn("快照渲染异常：" + (e && (e.stack || e.message || String(e)))); } catch (err2) { /* 记录失败则放弃 */ }
    }
  }

  var streamEnded = true;

  var streamDemoted = false; // 降级为纯轮询（探测发现实时流与并发请求互斥时）
  var streamProbed = false; // 本次页面加载是否已做过并发能力探测

  /**
   * 实时流并发能力探测：SSE 连接已收到字节后，验证普通请求是否仍能并发。
   * 个别桥接/代理把长连接与其它请求串行化（“能收流但发不出消息”），
   * 探测超时即调用 demoteStream 降级为纯轮询——功能完整，只是非实时。
   */
  function probeStreamSupport() {
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { return; } // 浏览器不支持则不探测
    var settled = false;
    var timer = window.setTimeout(function () {
      if (settled) return;
      settled = true;
      try { ctrl.abort(); } catch (e) { /* 忽略 */ }
    }, 4000);
    fetch("/api/health", { signal: ctrl.signal })
      .then(function () {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
      })
      .catch(function () {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        demoteStream("网络不太稳定，已自动改用兼容方式连接，消息会稍慢一点");
      });
  }

  /** 降级：停掉实时流并固定为兼容连接；会话元信息行持续标注“兼容连接”。 */
  function demoteStream(message) {
    streamDemoted = true;
    stopStream();
    showConnBanner(message);
    startPolling();
  }

  function onStreamEnd() {
    if (streamEnded) return; // 已在重连/回退流程中：不重复启动
    streamEnded = true;
    showReconnecting(); // 瞬断被下一次成功刷新清除；中断超过 1 秒才显示横幅
    if (sessionStreamCancel) { try { sessionStreamCancel(); } catch (e) { /* 忽略 */ } } // 顺带清看门狗与挂起的读循环
    // 先拉一次保证状态最新，再回退轮询，2.5 秒后尝试重连流（sinceSeq 续传，不丢不重）
    sessionStreamCancel = null;
    refresh();
    startPolling();
    if (streamDemoted) return; // 已降级为纯轮询：不再重连实时流
    window.setTimeout(function () {
      streamEnded = false;
      startStream();
    }, 2500);
  }

  function startPolling() {
    if (!sessionPollTimer) sessionPollTimer = window.setInterval(refresh, 1500);
  }

  function stopPolling() {
    if (sessionPollTimer) { window.clearInterval(sessionPollTimer); sessionPollTimer = null; }
  }

  function stopStream() {
    if (sessionStreamCancel) { sessionStreamCancel(); sessionStreamCancel = null; }
  }

  function submitAnswer(turnId, answer, btns) {
    if (answering) return; // 本地防重复点击；服务端另有幂等保证
    answering = true;
    answeringTurnId = turnId;
    if (btns) {
      Array.prototype.forEach.call(btns.querySelectorAll("button"), function (b) { b.disabled = true; });
    }
    apiCall(
      "/api/sessions/" + encodeURIComponent(sessionId) + "/turns/" + encodeURIComponent(turnId) + "/answer",
      { method: "POST", body: JSON.stringify({ answer: answer }) }
    )
      .then(function () {
        hideConnBanner();
        // 不跳转：流/轮询会把状态带成 answered → 继续；重复回答由服务端幂等吸收
      })
      .catch(function (e) {
        if (e && e.kind === "http" && (e.status === 400 || e.status === 409)) {
          // 非法回答 / 已有别的回答 / 已结束：刷新一次让页面与服务端对齐
          refresh();
        } else {
          failWith(e);
        }
      })
      .finally(function () {
        answering = false;
        answeringTurnId = null;
      });
  }

  msgForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var node = msgForm.elements.namedItem("message");
    var message = (node && node.value || "").trim();
    if (!message) return;
    stickToBottom = true; // 发消息后强制滚到底
    sendBtn.disabled = true;
    sendBtn.textContent = "发送中…";
    apiCall(
      "/api/sessions/" + encodeURIComponent(sessionId) + "/messages",
      { method: "POST", body: JSON.stringify({ message: message, idempotencyKey: uuid() }) }
    )
      .then(function (res) {
        hideConnBanner();
        sendBtn.disabled = false;
        sendBtn.textContent = "发送";
        node.value = "";
        var t = res && res.turn;
        if (t && t.id) {
          // 新轮次：旧轮次的气泡与卡片保留在原位（并入历史流）；SSE 游标归零让流重放全量，
          // 已渲染事件由 renderedEventKeys 去重（旧轮次不重复，新轮次正常追加）
          streamSeq = 0;
          refresh();
        }
        scrollToBottom();
      })
      .catch(function (e) {
        sendBtn.disabled = false;
        sendBtn.textContent = "发送";
        if (e && e.kind === "http" && e.status === 409) {
          var body = (e && e.body) || {};
          if (body.error === "SESSION_BUSY") {
            showConnBanner("本会话有一轮进行中");
          } else {
            showConnBanner("消息被拒绝，请重试");
          }
        } else if (e && e.kind === "http" && e.status === 400) {
          showConnBanner("请写 1 到 2000 个字");
        } else {
          failWith(e);
        }
      });
  });

  // 回车发送（Shift+Enter 换行；输入法组合中不触发）
  var msgInput = msgForm.elements.namedItem("message");
  msgInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (typeof msgForm.requestSubmit === "function") msgForm.requestSubmit();
      else msgForm.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  // ---------- 本地缓存秒开：先用 localStorage 里按会话 id 存的最近快照渲染，再向服务器刷新 ----------
  var loadingNode = null; // 无缓存时的加载占位（首个服务器快照到达即移除）
  var cacheApplied = false; // 当前页面是否正显示缓存内容（仅首次刷新失败时提示“离线”）
  var cachedSnapshot = readSessionCache(sessionId);
  if (cachedSnapshot) {
    applySnapshot(cachedSnapshot, { fromCache: true }); // 秒开：缓存先渲染（首帧不触发通知）
    cacheApplied = true;
    setMeta("更新中…"); // 明确标识：当前内容来自缓存，并非最终状态
  } else {
    loadingNode = loadingPlaceholder("chat");
    chatFlow.appendChild(loadingNode);
  }

  refresh();
  streamEnded = false;
  startStream();
}

// ---------------- 启动 ----------------

function boot() {
  var page = document.body.getAttribute("data-page");
  initTokenDialog();
  initThemeButtons();
  // 首页即会话主页：入口统一到 /session.html（配对 → 会话列表 → 新建/继续会话）
  if (page === "home") {
    window.location.replace("/session.html");
  } else if (page === "tools") {
    loadToolsPage();
  } else if (page === "form") {
    loadForm();
  } else if (page === "task") {
    loadTaskPage();
  } else if (page === "session") {
    loadSessionPage();
  }
}

document.addEventListener("DOMContentLoaded", boot);

// 尽早应用已存主题（脚本在 body 末尾，DOM 已就绪）：减少深色模式首屏闪烁；按钮由 boot 绑定
applyTheme(currentThemeMode());
