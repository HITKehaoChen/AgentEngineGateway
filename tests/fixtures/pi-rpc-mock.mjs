import { writeFileSync } from "node:fs";

const mode = process.env.PI_MOCK_MODE ?? "complete";
const countFile = process.env.PI_MOCK_COUNT_FILE;
const replyFile = process.env.PI_MOCK_REPLY_FILE;
if (process.env.PI_MOCK_PID_FILE) writeFileSync(process.env.PI_MOCK_PID_FILE, String(process.pid), "utf8");
let buffer = "";
let waitingForUi = false;
let abortCount = 0;
let outputTail = Promise.resolve();

function emit(value, split = false) {
  const line = `${JSON.stringify(value)}\r\n`;
  outputTail = outputTail.then(() => new Promise((resolve) => {
    if (!split) { process.stdout.write(line); resolve(); return; }
    const middle = Math.max(1, Math.floor(line.length / 2));
    process.stdout.write(line.slice(0, middle));
    setTimeout(() => { process.stdout.write(line.slice(middle)); resolve(); }, 1);
  }));
}

function complete() {
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" } }, mode === "chunked");
  emit({ type: "agent_settled" }, mode === "chunked");
}

function onCommand(command) {
  if (command.type === "new_session") {
    emit({ type: "session", version: 3, id: "pi_mock_session", cwd: process.cwd() }, mode === "chunked");
    emit({ id: command.id, type: "response", command: "new_session", success: true }, mode === "chunked");
    return;
  }
  if (command.type === "prompt") {
    if (mode === "timeout") return;
    emit({ id: command.id, type: "response", command: "prompt", success: true }, mode === "chunked");
    emit({ type: "agent_start" }, mode === "chunked");
    if (mode === "invalid") { process.stdout.write("not-json\r\n"); return; }
    if (mode === "exit") { setTimeout(() => process.exit(7), 10); return; }
    if (mode === "question") {
      waitingForUi = true;
      emit({ type: "extension_ui_request", id: "question_mock", method: "select", title: "Choose", options: ["Alpha", "Beta"] });
      return;
    }
    if (mode === "permission") {
      waitingForUi = true;
      emit({ type: "extension_ui_request", id: "permission_mock", method: "select", title: 'Permission: write [patterns: ["*.docx"]]', options: ["Once", "Always", "Reject"] });
      return;
    }
    if (mode === "abort") return;
    complete();
    return;
  }
  if (command.type === "extension_ui_response" && waitingForUi) {
    if (replyFile) writeFileSync(replyFile, JSON.stringify(command), "utf8");
    waitingForUi = false;
    complete();
    return;
  }
  if (command.type === "abort") {
    abortCount += 1;
    if (countFile) writeFileSync(countFile, String(abortCount), "utf8");
    if (mode === "abort-settled-first") {
      emit({ type: "agent_settled" });
      setTimeout(() => emit({ id: command.id, type: "response", command: "abort", success: true }), 5);
    } else {
      emit({ id: command.id, type: "response", command: "abort", success: true });
      setTimeout(() => emit({ type: "agent_settled" }), 5);
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try { onCommand(JSON.parse(line)); } catch { process.exitCode = 2; }
  }
});
