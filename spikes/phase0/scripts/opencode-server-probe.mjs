import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const fixtureDir = path.join(root, "spikes", "phase0", "fixtures");
const config = path.join(root, "spikes", "phase0", "opencode", "opencode.json");
const opencode = path.join(
  process.env.APPDATA ?? "",
  "npm",
  "node_modules",
  "opencode-ai",
  "bin",
  "opencode.exe",
);
const port = 6220;
const base = `http://127.0.0.1:${port}`;
const directoryQuery = `directory=${encodeURIComponent(root)}`;

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

await mkdir(fixtureDir, { recursive: true });

const server = spawn(
  opencode,
  ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure", "--print-logs"],
  {
    cwd: root,
    env: { ...process.env, OPENCODE_CONFIG: config },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let startup = "";
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => (startup += chunk));
server.stderr.on("data", (chunk) => (startup += chunk));

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function request(method, route, body) {
  const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}${directoryQuery}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${route} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

const events = [];
let eventAbort;

try {
  await waitUntil(
    async () => {
      try {
        return (await fetch(`${base}/doc`)).ok;
      } catch {
        return false;
      }
    },
    "OpenCode server",
  );

  eventAbort = new AbortController();
  const eventResponse = await fetch(`${base}/event?${directoryQuery}`, { signal: eventAbort.signal });
  const readEvents = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of eventResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary).replaceAll("\r", "");
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          events.push(JSON.parse(line.slice(5).trim()));
        }
      }
    }
  })().catch((error) => {
    if (error.name !== "AbortError") throw error;
  });

  const model = { providerID: "deepseek-phase0", modelID: "deepseek-v4-flash-vision-exp" };

  const questionSession = await request("POST", "/session", {
    title: "phase0-question-probe",
    permission: [{ permission: "question", pattern: "*", action: "allow" }],
  });
  await request("POST", `/session/${questionSession.id}/prompt_async`, {
    model,
    parts: [
      {
        type: "text",
        text: "Use the question tool to ask me to choose Alpha or Beta. After the answer, reply exactly CHOICE:<label>.",
      },
    ],
  });
  const question = await waitUntil(
    async () => (await request("GET", "/question")).find((item) => item.sessionID === questionSession.id),
    "OpenCode question",
  );
  await request("POST", `/question/${question.id}/reply`, { answers: [["Alpha"]] });
  await waitUntil(
    async () => {
      const messages = await request("GET", `/session/${questionSession.id}/message`);
      return messages.some((message) =>
        message.info?.role === "assistant" && message.parts?.some((part) => part.type === "text" && part.text === "CHOICE:Alpha"),
      );
    },
    "OpenCode question continuation",
  );

  const permissionSession = await request("POST", "/session", {
    title: "phase0-permission-probe",
    permission: [{ permission: "bash", pattern: "*", action: "ask" }],
  });
  await request("POST", `/session/${permissionSession.id}/prompt_async`, {
    model,
    parts: [
      {
        type: "text",
        text: "Use bash to run: powershell -NoProfile -Command \"Write-Output PHASE0_PERMISSION_OK\". Then reply exactly PHASE0_PERMISSION_DONE.",
      },
    ],
  });
  const permission = await waitUntil(
    async () => (await request("GET", "/permission")).find((item) => item.sessionID === permissionSession.id),
    "OpenCode permission",
  );
  await request("POST", `/permission/${permission.id}/reply`, { reply: "once", message: "phase0 approval" });
  await waitUntil(
    async () => {
      const messages = await request("GET", `/session/${permissionSession.id}/message`);
      return messages.some((message) =>
        message.info?.role === "assistant" &&
        message.parts?.some((part) => part.type === "text" && part.text === "PHASE0_PERMISSION_DONE"),
      );
    },
    "OpenCode permission continuation",
  );

  const abortSession = await request("POST", "/session", { title: "phase0-abort-probe" });
  await request("POST", `/session/${abortSession.id}/prompt_async`, {
    model,
    parts: [{ type: "text", text: "Write a 5000-word essay about distributed systems. Do not use tools." }],
  });
  await waitUntil(
    async () => {
      const status = await request("GET", "/session/status");
      return status[abortSession.id]?.type === "busy";
    },
    "OpenCode busy state",
  );
  const aborted = await request("POST", `/session/${abortSession.id}/abort`, {});
  if (aborted !== true) throw new Error("OpenCode abort was not acknowledged");
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const sessionIds = new Set([questionSession.id, permissionSession.id, abortSession.id]);
  const selected = events.filter(
    (event) =>
      event.type === "server.connected" ||
      sessionIds.has(event.properties?.sessionID) ||
      sessionIds.has(event.properties?.info?.sessionID) ||
      sessionIds.has(event.properties?.part?.sessionID),
  );
  await writeFile(
    path.join(fixtureDir, "opencode-server-interactions.raw.jsonl"),
    `${selected.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "opencode-server-probe.summary.json"),
    `${JSON.stringify(
      {
        question: { sessionID: questionSession.id, requestID: question.id, answer: "Alpha" },
        permission: { sessionID: permissionSession.id, requestID: permission.id, reply: "once" },
        abort: { sessionID: abortSession.id, acknowledged: aborted },
        capturedEvents: selected.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  eventAbort.abort();
  await readEvents;
} finally {
  eventAbort?.abort();
  if (server.exitCode === null) {
    spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  }
}
