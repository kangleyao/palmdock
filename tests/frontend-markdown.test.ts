// 安全 Markdown 渲染与会话快照缓存的单元测试。
// 自建最小 DOM 桩（createElement / createTextNode / appendChild / remove /
// textContent / setAttribute），把 public/app.js 加载进 vm 沙箱后直接跑
// renderMarkdownInto / readableResultText / 缓存读写，不依赖浏览器与第三方库。
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 极简 DOM 节点桩：只实现渲染路径用到的 API（与真实浏览器行为对齐）。
 * 注意：textContent 赋值会清空子节点并等价于持有一个文本子节点——
 * 与真实 DOM 一致，序列化时要把它当文本输出。
 */
class FakeNode {
  tag: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  private _text: string | null = null;
  className = "";
  attrs: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(): void {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }
  get textContent(): string {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children = [];
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  /** 序列化用：读取“textContent 赋值”生成的文本（等价于文本子节点）。 */
  get directText(): string | null { return this._text; }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把假 DOM 序列化成 HTML 形式的字符串，供断言（文本一律转义，与浏览器渲染一致）。 */
function serialize(node: FakeNode): string {
  if (node.tag === "#text") return esc(node.textContent);
  // href / target / rel 等经直接属性赋值设置（与浏览器一致会反映为属性），序列化时要输出
  const nodeAny = node as unknown as Record<string, unknown>;
  const internal = new Set(["tag", "children", "parent", "_text", "className", "attrs", "directText"]);
  const ownAttrs = Object.keys(nodeAny)
    .filter((k) => !internal.has(k))
    .map((k) => ` ${k}="${esc(String(nodeAny[k]))}"`)
    .join("");
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("") + ownAttrs;
  const cls = node.className ? ` class="${node.className}"` : "";
  // textContent 赋值的元素等价于拥有一个文本子节点（保留标签本身）
  const inner = node.directText !== null ? esc(node.directText) : node.children.map(serialize).join("");
  if (node.tag === "br" || node.tag === "hr") return `<${node.tag}${cls}${attrs}>`;
  return `<${node.tag}${cls}${attrs}>${inner}</${node.tag}>`;
}

interface SandboxExtras {
  flushTimers: () => void;
  store: Record<string, string>;
}

/** 加载 app.js 到带假 document 的沙箱；返回沙箱全局与缓存用的额外句柄。 */
function loadFrontendSandbox(): Record<string, unknown> & SandboxExtras {
  const code = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const pendingTimers: Array<() => void> = [];
  const store: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  const fakeDoc = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode("#text");
      n.textContent = text;
      return n;
    },
    addEventListener: () => {},
    documentElement: { setAttribute: () => {}, getAttribute: () => "auto" },
    body: { getAttribute: () => null },
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const sandbox: Record<string, unknown> = {
    window: {
      isSecureContext: true,
      localStorage: storage,
      setTimeout: (f: () => void) => { pendingTimers.push(f); return 1; },
      clearTimeout: () => {},
    },
    document: fakeDoc,
    localStorage: storage,
    console: { warn: () => {} },
    crypto: { getRandomValues: (buf: Uint8Array) => buf },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000 });
  const extras: SandboxExtras = {
    flushTimers: () => { pendingTimers.splice(0).forEach((f) => f()); },
    store,
  };
  return Object.assign(sandbox, extras);
}

const sandbox = loadFrontendSandbox();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = sandbox as any;

/** 便利：把 Markdown 源文本渲染进一个容器并序列化。 */
function renderMd(source: string): string {
  const host = new FakeNode("div");
  fn.renderMarkdownInto(host, source);
  return serialize(host);
}

test("源码红线：app.js 全程不含动态 HTML 注入与字符串求值", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  assert.ok(src.indexOf("innerHTML") < 0, "app.js 不得出现 innerHTML");
  assert.ok(src.indexOf("insertAdjacentHTML") < 0, "app.js 不得出现 insertAdjacentHTML");
  assert.ok(src.indexOf("outerHTML") < 0, "app.js 不得出现 outerHTML 赋值");
  assert.ok(src.indexOf("document.write") < 0, "app.js 不得出现 document.write");
  assert.ok(src.indexOf("new Function") < 0, "app.js 不得出现 new Function");
  assert.ok(!/\beval\s*\(/.test(src), "app.js 不得出现 eval(");
});

test("原文 HTML 一律按文本显示：<script>alert(1)</script> 绝不被解释执行", () => {
  const out = renderMd("警告：<script>alert(1)</script> 与 <img onerror=\"x\"> 都是文本");
  assert.ok(out.indexOf("&lt;script&gt;alert(1)&lt;/script&gt;") >= 0, "script 标签应转义为文本");
  assert.ok(out.indexOf("<script>") < 0, "序列化结果不得出现真实 script 标签");
  assert.ok(out.indexOf("&lt;img onerror=\"x\"&gt;") >= 0, "img 标签应转义为文本");
  assert.ok(out.indexOf("<img") < 0, "不得出现真实 img 标签");
});

test("链接仅允许 http/https：javascript:/data:/相对协议一律降级为字面文本", () => {
  const out = renderMd("点 [x](javascript:alert(1)) 与 [y](data:text/html,hi) 和 [z](/relative)");
  assert.ok(out.indexOf("<a") < 0, "非法协议链接不得渲染成 <a>");
  assert.ok(out.indexOf("[x](javascript:alert(1))") >= 0, "javascript: 链接应按字面文本呈现");
  assert.ok(out.indexOf("[y](data:text/html,hi)") >= 0, "data: 链接应按字面文本呈现");
  assert.ok(out.indexOf("[z](/relative)") >= 0, "相对链接应按字面文本呈现");
});

test("合法链接渲染为 <a>，带 target=_blank 与 rel=noopener noreferrer", () => {
  const out = renderMd("见 [文档](https://example.com/a) 与 [另](http://x.org)");
  assert.ok(
    out.indexOf('<a class="md-link" href="https://example.com/a" target="_blank" rel="noopener noreferrer">文档</a>') >= 0,
    "https 链接应有完整安全属性"
  );
  assert.ok(out.indexOf('href="http://x.org"') >= 0, "http 链接也应渲染");
  assert.ok(out.indexOf('rel="noopener noreferrer"') >= 0, "必须带 rel 防反向标签页劫持");
});

test("行内强调：粗体、斜体、行内代码", () => {
  assert.ok(renderMd("**粗体**").indexOf("<strong>粗体</strong>") >= 0);
  assert.ok(renderMd("*斜体*").indexOf("<em>斜体</em>") >= 0);
  const code = renderMd("用 `count()` 计数");
  assert.ok(code.indexOf('<code class="md-code">count()</code>') >= 0);
  // 行内代码内部不再解析 Markdown
  assert.ok(renderMd("`不是 **粗体**`").indexOf("<strong>") < 0, "行内代码内部不应再解析粗体");
});

test("块级：围栏代码块（``` 与 ~~~），内容为纯文本", () => {
  const out = renderMd("前\n\n```js\nif (1) {\n  log('<b>x</b>');\n}\n```\n\n后");
  assert.ok(
    out.indexOf('<pre class="md-code-block"><code>if (1) {\n  log(\'&lt;b&gt;x&lt;/b&gt;\');\n}</code></pre>') >= 0,
    "围栏代码块应为 pre>code，且内部 HTML 转义"
  );
  const out2 = renderMd("~~~\nplain\n~~~");
  assert.ok(out2.indexOf('<pre class="md-code-block"><code>plain</code></pre>') >= 0, "~~~ 也可作围栏");
  // 未闭合的围栏：渲染到末尾
  const out3 = renderMd("```\nfoo\nbar");
  assert.ok(out3.indexOf("foo\nbar") >= 0);
});

test("块级：引用、无序列表、有序列表、分隔线、段内换行", () => {
  assert.ok(renderMd("> 引用一句").indexOf('<blockquote class="md-quote">') >= 0);
  const ul = renderMd("- 一\n- 二\n- 三");
  assert.ok(ul.indexOf('<ul class="md-ul">') >= 0);
  assert.ok(ul.indexOf('<li class="md-li">二</li>') >= 0);
  const ol = renderMd("1. 甲\n2. 乙");
  assert.ok(ol.indexOf('<ol class="md-ol">') >= 0);
  assert.ok(ol.indexOf('<li class="md-li">乙</li>') >= 0);
  assert.ok(renderMd("---").indexOf('<hr class="md-hr">') >= 0);
  const two = renderMd("第一行\n第二行");
  assert.ok(two.indexOf("<br>") >= 0, "段内单换行渲染为 <br>");
  assert.ok(two.indexOf("第一行") >= 0 && two.indexOf("第二行") >= 0);
});

test("块级：空行分段，多段落结构", () => {
  const out = renderMd("段一\n\n段二\n\n段三");
  const count = (out.split('<div class="md-p">').length - 1);
  assert.equal(count, 3);
});

test("渲染器对空串与特殊字符不抛错（回归桩）", () => {
  const host = new FakeNode("div");
  fn.renderMarkdownInto(host, "");
  fn.renderMarkdownInto(host, "**仅粗体**");
  assert.ok(host.children.length >= 1);
});

test("readableResultText：保守识别可读字段，其余一律 null（维持现状）", () => {
  assert.equal(fn.readableResultText({ summary: "**摘要**" }), "**摘要**");
  assert.equal(fn.readableResultText({ message: "完成" }), "完成");
  assert.equal(fn.readableResultText({ text: "正文" }), "正文");
  // 字段优先级：summary > message > text
  assert.equal(fn.readableResultText({ summary: "s", message: "m", text: "t" }), "s");
  // 非字符串 / 空白：不算可读
  assert.equal(fn.readableResultText({ summary: 123 }), null);
  assert.equal(fn.readableResultText({ summary: "   " }), null);
  assert.equal(fn.readableResultText({ summary: "" }), null);
  // 拿不准的结构：一律 null，交给原始 JSON
  assert.equal(fn.readableResultText({ echo: { a: 1 } }), null);
  assert.equal(fn.readableResultText([1, 2]), null);
  assert.equal(fn.readableResultText(null), null);
  assert.equal(fn.readableResultText("字面字符串结果"), null);
});

test("会话缓存：读写带回 schema 版本号；不匹配版本直接忽略", () => {
  const snap = {
    session: { id: "s1", toolId: "fake-ai" },
    turns: [{ id: "t1", message: "嗨", status: "succeeded" }],
    liveTurnId: null,
    lastTurnId: "t1",
    events: [{ seq: 3, type: "info", message: "嗨", turnId: "t1" }],
  };
  fn.writeSessionCache("s1", snap);
  sandbox.flushTimers();
  // 读回的对象创建于 vm 沙箱 realm：经 JSON 归一化后再比较，避免跨 realm 原型差异
  const read = fn.readSessionCache("s1");
  assert.deepEqual(JSON.parse(JSON.stringify(read)), snap);
  // 旧版本缓存：忽略
  sandbox.store["agb_sess_s1"] = JSON.stringify({ v: 0, snapshot: snap });
  assert.equal(fn.readSessionCache("s1"), null);
  // 损坏内容：忽略
  sandbox.store["agb_sess_s1"] = "{not json";
  assert.equal(fn.readSessionCache("s1"), null);
  // 结构不符：忽略
  sandbox.store["agb_sess_s1"] = JSON.stringify({ v: 1, snapshot: { session: "nope" } });
  assert.equal(fn.readSessionCache("s1"), null);
  // 不存在的 key
  assert.equal(fn.readSessionCache("never"), null);
  assert.equal(fn.readSessionCache(""), null);
});

test("会话缓存：负载不含 token / 口令 / 鉴权信息", () => {
  fn.writeSessionCache("s2", { session: { id: "s2" }, turns: [], liveTurnId: null, lastTurnId: null, events: [] });
  sandbox.flushTimers();
  const raw = sandbox.store["agb_sess_s2"];
  assert.ok(raw, "缓存应已写入");
  const lower = raw.toLowerCase();
  assert.ok(lower.indexOf("token") < 0, "缓存负载不得出现 token 字样");
  assert.ok(lower.indexOf("bearer") < 0, "缓存负载不得出现 Bearer 字样");
  assert.ok(lower.indexOf("authorization") < 0, "缓存负载不得出现 authorization 字样");
});

test("缓存写入带防抖：防抖期内重复调用只落盘一次", () => {
  const snap = { session: { id: "s3" }, turns: [], liveTurnId: null, lastTurnId: null, events: [] };
  fn.writeSessionCache("s3", snap);
  fn.writeSessionCache("s3", snap);
  fn.writeSessionCache("s3", snap);
  assert.ok(!Object.prototype.hasOwnProperty.call(sandbox.store, "agb_sess_s3"), "防抖期内不应落盘");
  sandbox.flushTimers();
  assert.ok(Object.prototype.hasOwnProperty.call(sandbox.store, "agb_sess_s3"), "防抖结束后应落盘一次");
});

test("缓存键名与会话 id 绑定", () => {
  assert.equal(fn.sessionCacheKey("abc-123"), "agb_sess_abc-123");
});

test("加载态骨架屏：列表 3 块、聊天 2 块、卡片 3 块（纯 DOM 灰块，替代长驻 spinner）", () => {
  const list = fn.loadingPlaceholder("list");
  const chat = fn.loadingPlaceholder("chat");
  const card = fn.loadingPlaceholder("card");
  assert.equal(list.children.length, 3, "列表骨架 3 条");
  assert.equal(chat.children.length, 2, "聊天骨架 2 个气泡块");
  assert.equal(card.children.length, 3, "卡片骨架 3 块");
  assert.ok(serialize(chat.children[0] as FakeNode).includes('class="sk sk-bubble"'));
  assert.ok(serialize(chat.children[1] as FakeNode).includes("sk-bubble short"), "第二块收窄");
  assert.ok(serialize(card.children[0] as FakeNode).includes('class="sk sk-card"'));
  assert.ok(serialize(list.children[0] as FakeNode).includes('class="sk sk-row"'));
});

test("会话行必须带可用深链：renderSessionRow 产出 <a class='srow enter'> 且 href 指向 session.html?id=<该会话>", () => {
  // R8 加进场动画类时误删 row.href，列表“点不动”整轮 P0；此断言钉住跳转手段
  const host = new FakeNode("div");
  fn.renderSessionRow(
    host,
    { id: "s-123", toolId: "fake-ai", lastTurnMessage: "嗨", lastTurnAt: null, createdAt: "2026-10-01T08:00:00Z", turnCount: 2, lastTurnStatus: "succeeded" },
    { "fake-ai": "演示助手" }
  );
  const row = host.children[0] as any;
  assert.equal(row.tag, "a", "会话行应为 <a>");
  assert.equal(row.className, "srow enter", "保留进场动画类");
  assert.ok(typeof row.href === "string" && row.href.length > 0, "必须有 href（R8 曾整行丢失）");
  assert.ok(row.href.indexOf("/session.html?id=") === 0, "深链前缀正确");
  assert.ok(row.href.indexOf(encodeURIComponent("s-123")) >= 0, "深链携带该会话 id");
});

test("可见元素守卫：renderOutcomeCard 的结果卡必须创建「结果」标签（.result-card-head）", () => {
  // R8 整块 PUT 时顺带吞掉此行（结果卡没有标题），R12 补回；此断言钉住它不再被静默删除。
  // renderOutcomeCard 处于会话详情闭包内，测试沙箱无法直接调用，故对其函数体做源码结构断言。
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const m = /function renderOutcomeCard[\s\S]*?\n  \}/.exec(src);
  assert.ok(m, "应能定位 renderOutcomeCard 函数体");
  assert.ok(m![0].indexOf('el("div", "结果", "result-card-head")') >= 0, "结果卡内必须有「结果」标签行");
});

test("触摸高度守卫：.ev-tray-toggle 规则块含 min-height ≥ 44px（node 无布局引擎，用源码断言 + 浏览器实测双保险）", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "style.css"), "utf8");
  const m = /\.ev-tray-toggle\s*\{[^}]*\}/.exec(css);
  assert.ok(m, "应能定位 .ev-tray-toggle 规则块");
  assert.ok(/min-height:\s*44px/.test(m![0]), "折叠按钮最小高度必须为 44px（手机触摸门槛）");
});

test("打字指示器三个点守卫：renderTyping 必须创建 3 个 <i>", () => {
  // R8 吞掉一个 append（3 点变 2 点），R12 追加补回；按出现次数比对的方法钉住 3 个。
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const m = /function renderTyping[\s\S]*?\n  \}/.exec(src);
  assert.ok(m, "应能定位 renderTyping 函数体");
  const count = m![0].split("typing.appendChild(el(\"i\"));").length - 1;
  assert.equal(count, 3, `renderTyping 内 typing.appendChild(el(\"i\")); 应为 3 次，实际 ${count} 次`);
});
test("readableResultText：识别 assistantText（DSH 真实轮次 result 的正文字段），优先级与保守性不变", () => {
  // 规划会话实测：DSH 轮次 result 的键只有 sessionId/assistantText/turnEndReason/finalEventSeq，
  // 改前只认 summary/message/text → 正文落 else 分支以可见 JSON 直出（与 AI 气泡重复且不可读）。
  assert.equal(fn.readableResultText({ sessionId: "s", assistantText: "正文", turnEndReason: "stop", finalEventSeq: 9 }), "正文");
  assert.equal(fn.readableResultText({ assistantText: "正文" }), "正文");
  // 优先级：summary > message > text > assistantText
  assert.equal(fn.readableResultText({ text: "t", assistantText: "a" }), "t");
  assert.equal(fn.readableResultText({ summary: "s", assistantText: "a" }), "s");
  assert.equal(fn.readableResultText({ message: "m", assistantText: "a" }), "m");
  // 非字符串 / 空白 / null：不算可读（不得把空 assistantText 当正文渲染）
  assert.equal(fn.readableResultText({ assistantText: 123 }), null);
  assert.equal(fn.readableResultText({ assistantText: "   " }), null);
  assert.equal(fn.readableResultText({ assistantText: "" }), null);
  assert.equal(fn.readableResultText({ assistantText: null, sessionId: "s" }), null);
});

test("结果卡原始 JSON 默认收起守卫：pre.code 一律带 hidden，renderOutcomeCard 不再直出可见 JSON（R13）", () => {
  // R13 前的 else 分支：card.appendChild(el("pre", JSON.stringify(t.result, null, 2), "code")) 无 hidden，默认可见。
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const m = /function renderOutcomeCard[\s\S]*?\n  }/.exec(src);
  assert.ok(m, "应能定位 renderOutcomeCard 函数体");
  assert.ok(m![0].indexOf('el("pre"') < 0, "结果卡内不得直接创建 <pre>（原始 JSON 只能经 appendRawResultToggle 折叠）");
  assert.ok(m![0].indexOf("isAnswerAlreadyRendered") >= 0, "结果卡必须先做同轮正文去重判定");
  assert.ok(m![0].indexOf("renderMarkdownInto(body, readable)") >= 0, "可读正文应按 Markdown 渲染");
  assert.ok(m![0].indexOf("本轮正文已在上方消息中") >= 0, "同轮已渲染过的正文只留短状态行");
  assert.equal(m![0].split("appendRawResultToggle").length - 1, 4, "结果卡内折叠调用应为 4 处（失败 1 + 结果三态 3）");
  // 折叠器本体：<pre> 创建时带 hidden（默认不可见，点按钮才展开）
  const tog = /function appendRawResultToggle[\s\S]*?\n}/.exec(src);
  assert.ok(tog, "应能定位 appendRawResultToggle 函数体");
  assert.ok(tog![0].indexOf("code raw-result hidden") >= 0, "原始结果 <pre> 必须带 hidden（默认不可见）");
});

test("同轮正文去重守卫：isAnswerAlreadyRendered 保守判定（已登记→true；拿不准→false）", () => {
  // 判定不上当没渲染过：宁可多显示一次正文，也不漏显示。
  const rec = { renderedAnswers: { "正文A": true } };
  assert.equal(fn.isAnswerAlreadyRendered(rec, "正文A"), true);
  assert.equal(fn.isAnswerAlreadyRendered(rec, "正文B"), false);
  assert.equal(fn.isAnswerAlreadyRendered({ renderedAnswers: {} }, "正文A"), false);
  assert.equal(fn.isAnswerAlreadyRendered(null, "正文A"), false);
  assert.equal(fn.isAnswerAlreadyRendered({}, "正文A"), false);
  assert.equal(fn.isAnswerAlreadyRendered(rec, ""), false);
  assert.equal(fn.isAnswerAlreadyRendered(rec, null), false);
  // 模拟同轮流：先登记一段正文（等价 appendEventBubble 的 answer 分支登记），再判定同一文本 → true
  const flow: { renderedAnswers: Record<string, boolean> } = { renderedAnswers: {} };
  flow.renderedAnswers["同一回答"] = true;
  assert.equal(fn.isAnswerAlreadyRendered(flow, "同一回答"), true);
  assert.equal(fn.isAnswerAlreadyRendered(flow, "同一回答（改了一点）"), false);
});

test("ATX 标题：1–6 级渲染为 h1–h6（md-h* 类），标题内行内强调照常解析", () => {
  const out = renderMd("# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级");
  for (let lv = 1; lv <= 6; lv++) {
    assert.ok(out.indexOf(`<h${lv} class="md-h${lv}">`) >= 0, `第 ${lv} 级应渲染为 <h${lv} class="md-h${lv}">`);
    assert.ok(out.indexOf("md-p") < 0, "标题行不应再走段落");
  }
  // 标题内联解析：粗体与行内代码（标题也是 inline 容器）
  const b = renderMd("## 带 **粗体** 与 `代号`");
  assert.ok(b.indexOf("<strong>粗体</strong>") >= 0, "标题内粗体应解析");
  assert.ok(b.indexOf('<code class="md-code">代号</code>') >= 0, "标题内行内代码应解析");
});

test("ATX 标题不与上/下段落合并（前段先收尾，顺序为 段→标题→段）", () => {
  const out = renderMd("上一段正文\n\n## 标题\n下一段正文");
  const pCount = out.split('<div class="md-p">').length - 1;
  assert.equal(pCount, 2, "前后各一段");
  assert.ok(out.indexOf('<h2 class="md-h2">标题</h2>') >= 0);
  const firstP = out.indexOf('<div class="md-p">');
  const h = out.indexOf('<h2 class="md-h2">');
  const lastP = out.lastIndexOf('<div class="md-p">');
  assert.ok(firstP < h && h < lastP, "标题应位于两段之间");
});

test("ATX 标题保守判定：#标签 / 单独 # / 七个井号 / 空内容 都不是标题（原样段落）", () => {
  const a = renderMd("#标签不是标题");
  assert.ok(a.indexOf('<div class="md-p">#标签不是标题</div>') >= 0 && a.indexOf("<h1") < 0, "井号后无空白不是标题");
  const b = renderMd("#");
  assert.ok(b.indexOf('<div class="md-p">#</div>') >= 0 && b.indexOf("<h1") < 0, "单独 # 不是标题");
  const d = renderMd("# ");
  assert.ok(d.indexOf("<h1") < 0, "# 后仅空白（无内容）也不是标题");
  const c = renderMd("####### 七个井号也不是标题");
  assert.ok(c.indexOf('<div class="md-p">####### 七个井号也不是标题</div>') >= 0 && c.indexOf("<h1") < 0, "7 个井号不是标题");
});

test("ATX 标题行尾闭合井号剥掉（## 带闭合 ## → 只剩内容）", () => {
  const out = renderMd("## 带闭合 ##");
  assert.ok(out.indexOf('<h2 class="md-h2">带闭合</h2>') >= 0, JSON.stringify(out));
  const out2 = renderMd("### 三级 标题 ###");
  assert.ok(out2.indexOf('<h3 class="md-h3">三级 标题</h3>') >= 0, "中段空格保留、尾部井号剥掉");
});

test("围栏代码块内的 # 行注解绝不被当标题（源码结构守卫：围栏分支在标题分支之前）", () => {
  const out = renderMd("```js\n# 行注解\nx = 1\n```");
  assert.ok(out.indexOf("<h1") < 0 && out.indexOf("<h2") < 0, "围栏内 # 行不应变成标题");
  assert.ok(out.indexOf("# 行注解") >= 0, "代码内容原样保留");
  // 源码结构：renderMarkdownInto 函数体内围栏分支必须位于标题分支之前
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "public", "app.js"), "utf8");
  const m = /function renderMarkdownInto[\s\S]*?\n}/.exec(src);
  assert.ok(m, "应能定位 renderMarkdownInto 函数体");
  const body = m![0];
  const fencePos = body.indexOf("fenceMatch");
  const headingPos = body.indexOf("headingMatch");
  assert.ok(fencePos > 0 && headingPos > fencePos, "围栏代码分支必须在标题分支之前");
  // 判定要素齐备：最多 3 空格 + 1–6 井号 + 空白 + 闭合井号剥离
  assert.ok(body.indexOf("/^ {0,3}(#{1,6})") >= 0, "标题正则须含 最多3空格+1-6井号");
  assert.ok(body.indexOf('+#+[ \\t]*$') >= 0, "须有闭合井号剥离");
});

test("引用块内的标题也要解析（引用分支递归调用）", () => {
  const out = renderMd("> ## 引言\n> 正文一句");
  assert.ok(out.indexOf('<blockquote class="md-quote">') >= 0);
  assert.ok(out.indexOf('<h2 class="md-h2">引言</h2>') >= 0, "引用内 ## 应解析为 h2");
});
