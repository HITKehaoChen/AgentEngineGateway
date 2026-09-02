import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const fixtureDir = path.join(root, "spikes", "phase0", "fixtures");
const piHome = path.join(root, "spikes", "phase0", "pi");
const npmRoot = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
const cli = path.join(npmRoot, "dist", "cli.js");
const extension = path.join(npmRoot, "examples", "extensions", "rpc-demo.ts");
const node = process.execPath;

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

await mkdir(fixtureDir, { recursive: true });

const child = spawn(
  node,
  [
    cli,
    "--provider",
    "deepseek-phase0",
    "--model",
    "deepseek-v4-flash-vision-exp",
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--extension",
    extension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ],
  {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: piHome },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

const events = [];
let stderr = "";
let buffer = "";
let interactionCompleted = false;
let promptSent = false;
let abortSent = false;
let settled = false;
let abortAcknowledged = false;

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Pi RPC probe timed out")), 45_000);

  function finishIfReady() {
    if (interactionCompleted && settled && abortAcknowledged) {
      clearTimeout(timeout);
      resolve();
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);

      if (event.type === "extension_ui_request" && event.method === "confirm") {
        send({ type: "extension_ui_response", id: event.id, confirmed: true });
      }
      if (event.type === "response" && event.id === "new-session" && event.success) {
        interactionCompleted = event.data?.cancelled === false;
        if (!promptSent) {
          promptSent = true;
          send({
            type: "prompt",
            id: "long-prompt",
            message: "Write a detailed 5000-word essay about distributed systems. Do not use tools.",
          });
        }
      }
      if (
        !abortSent &&
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        abortSent = true;
        send({ type: "abort", id: "abort-probe" });
      }
      if (event.type === "agent_settled") settled = true;
      if (event.type === "response" && event.id === "abort-probe" && event.success) abortAcknowledged = true;
      finishIfReady();
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", reject);
  child.on("exit", (code) => {
    if (!settled || !abortAcknowledged) reject(new Error(`Pi exited early (${code}): ${stderr}`));
  });
});

send({ type: "new_session", id: "new-session" });

try {
  await completed;
  await writeFile(
    path.join(fixtureDir, "pi-rpc-interaction-abort.raw.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "pi-rpc-probe.summary.json"),
    `${JSON.stringify(
      {
        interactionCompleted,
        abortAcknowledged,
        settled,
        capturedEvents: events.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
} finally {
  child.stdin.end();
  if (child.exitCode === null) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}
