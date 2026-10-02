#!/usr/bin/env node
// 假 AI：纯本地演示端。不联网、不读密钥、不读写用户文件；行为是 (消息, 轮序, 回答) 的固定函数。
//
// 通信协议（stdio，逐行 JSON）：
//   输入首行： {"type":"start","message":"…","turnIndex":N}
//   输入续行： {"type":"answer","answer":"选项"}   ← 父进程在手机回答后写入
//   输出行：   {"type":"output","text":"…"}       ← 分段输出（流式）
//              {"type":"ask","prompt":"…","options":["A","B"]}  ← 提问（恰好两个明确选项）
//              {"type":"done","result":{…}}      ← 最终结果，随后退出 0
//              {"type":"fatal","message":"…"}    ← 协议失败（父进程据此标记失败）
//
// 健壮性：stdin 一旦 EOF（父进程退出）立即退出，不留孤儿进程。
// 确定性：输出内容只依赖输入参数，不含时间戳/随机数；同一输入加同一回答，输出逐行一致。
// 失败指令：消息为“失败”或“fail”（忽略大小写与首尾空格）时，输出一段后以 fatal 结束——
// 用于让失败流程可确定地复现与测试；除此之外不会失败。

"use strict";

const SEGMENT_GAP_MS = 120; // 分段之间的固定间隔（仅为观感，不影响确定性）

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** 异步等待：让事件循环转起来，保证分段输出逐条写出到管道（流式观感）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取并解析一行 JSON；onLine 决定该行是否为所需类型。 */
function readLine(onLine) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      try {
        const msg = JSON.parse(line);
        const parsed = onLine(msg, line);
        if (parsed instanceof Error) reject(parsed);
        else resolve(parsed);
      } catch (e) {
        reject(new Error("行 JSON 解析失败：" + line.slice(0, 200)));
      }
    };
    const onEnd = () => {
      process.stdin.removeListener("data", onData);
      reject(new Error("stdin 在约定输入到达之前关闭"));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

function readStart() {
  return readLine((msg, line) => {
    if (msg && msg.type === "start") return msg;
    return new Error("首行必须是 type=start 的 JSON：" + line.slice(0, 200));
  });
}

function readAnswer() {
  return readLine((msg, line) => {
    if (msg && msg.type === "answer") return String(msg.answer);
    return new Error("回答行必须是 type=answer 的 JSON：" + line.slice(0, 200));
  });
}

async function main() {
  const start = await readStart();
  const message = String(start.message || "");
  const turnIndex = Number.isInteger(start.turnIndex) ? start.turnIndex : 0;

  // 失败指令：消息本身就是“失败/fail”时，输出一段后以 fatal 结束（供失败流程测试与演示）。
  // 与其它行为一样是固定函数：同一消息必失败，错误信息确定。
  const directive = message.trim().toLowerCase();
  if (directive === "失败" || directive === "fail") {
    send({ type: "output", text: `已收到失败指令“${message}”：这一轮会明确失败。` });
    await sleep(SEGMENT_GAP_MS);
    send({ type: "fatal", message: `模拟失败：消息为“${message}”` });
    process.exit(1);
  }

  // 分段输出（内容只依赖 message 与 turnIndex）
  const segments = [
    `已收到你的消息（${message.length} 字）：“${message}”。`,
    `这是本会话第 ${turnIndex + 1} 轮，我先理一下已知条件。`,
    "有两种生成方式，方向需要你定一下。",
  ];
  for (const text of segments) {
    send({ type: "output", text });
    await sleep(SEGMENT_GAP_MS);
  }

  // 提问：恰好两个明确选项
  const prompt = "下一步用哪种方式生成结果？";
  const options = ["精简版", "详细版"];
  send({ type: "ask", prompt, options });

  const answer = await readAnswer();

  // 收到回答后的收尾输出（内容只依赖 answer 与 turnIndex）
  const tail = [`好的，按“${answer}”继续。`, "结果已生成。"];
  for (const text of tail) {
    send({ type: "output", text });
    await sleep(SEGMENT_GAP_MS);
  }

  const result = {
    echo: message,
    messageLength: message.length,
    turnIndex: turnIndex,
    choice: answer,
    style: answer,
    plan: ["阅读消息", "确认方向", "生成结果"],
    summary: `已按“${answer}”完成第 ${turnIndex + 1} 轮的模拟处理。`,
  };
  send({ type: "done", result });
  process.exit(0);
}

main().catch((e) => {
  send({ type: "fatal", message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
