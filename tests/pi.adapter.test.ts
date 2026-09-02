import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPiMappingState, mapPiEvent } from "../src/harness/pi/event-mapper.js";
import { buildPiModelsConfig, PiAdapter } from "../src/harness/pi/adapter.js";
import type { EngineEvent } from "../src/model/types.js";
import registerGatewayBridge from "../src/harness/pi/gateway-bridge.js";

const children = new Set<PiAdapter>();
const mockPath = path.resolve("tests/fixtures/pi-rpc-mock.mjs");

afterEach(async () => { for (const adapter of children) await adapter.stop(); children.clear(); });

function createMockAdapter(mode: string, countFile?: string, pidFile?: string, replyFile?: string): { adapter: PiAdapter; args: string[]; commands: string[] } {
  const args: string[] = [];
  const commands: string[] = [];
  const adapter = new PiAdapter({ command: "pi", expectedVersion: "0.84.4", controlTimeoutMs: 1_000, abortGraceMs: 1_000, spawnImpl: ((_command: string, childArgs: string[], options: any) => {
    commands.push(_command);
    args.push(...childArgs);
    return spawn(process.execPath, [mockPath], { cwd: options.cwd, env: { ...options.env, PI_MOCK_MODE: mode, ...(countFile ? { PI_MOCK_COUNT_FILE: countFile } : {}), ...(pidFile ? { PI_MOCK_PID_FILE: pidFile } : {}), ...(replyFile ? { PI_MOCK_REPLY_FILE: replyFile } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  }) as typeof spawn });
  children.add(adapter);
  return { adapter, args, commands };
}

async function startMock(adapter: PiAdapter): Promise<{ opaqueId: string }> {
  const model = { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" };
  await adapter.start({ command: "pi", version: "0.84.4", model, startupTimeoutMs: 500, healthTimeoutMs: 100 });
  return adapter.createSession({ gatewaySessionId: `gateway_${Math.random().toString(16).slice(2)}`, title: "测试", directory: process.cwd() });
}

test("Pi runtime config references the credential environment without persisting the secret", () => {
  const config = buildPiModelsConfig({ providerId: "glm", modelId: "glm-5.2", baseUrl: "https://glm.example/v1", credentialRef: "env:MODEL_API_KEY" });
  assert.deepEqual(config.providers.glm, { baseUrl: "https://glm.example/v1", api: "openai-completions", apiKey: "$MODEL_API_KEY", authHeader: true, models: [{ id: "glm-5.2", name: "glm-5.2" }] });
  assert.equal(JSON.stringify(config).includes("MODEL_API_KEY_VALUE"), false);
});

test("Pi rejects custom shell shims instead of silently replacing or shelling them", async () => {
  const adapter = new PiAdapter({ command: "C:\\custom\\agent.cmd", expectedVersion: "0.84.4" });
  await assert.rejects(() => adapter.start({ command: "C:\\custom\\agent.cmd", version: "0.84.4", model: { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" }, startupTimeoutMs: 500, healthTimeoutMs: 100 }), /\.cmd\/.bat shims are not supported/);
});

test("production Pi bridge registers callable question and permission tools", async () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  registerGatewayBridge({ registerTool: (definition: { name: string; execute: Function }) => tools.push(definition) } as any);
  assert.deepEqual(tools.map((tool) => tool.name), ["question", "permission"]);
  const ui = { select: async (title: string, options: string[]) => { selections.push({ title, options }); return options[1] ?? "Alpha"; }, input: async () => "free text", confirm: async () => true };
  const ctx = { hasUI: true, ui };
  const question = await tools[0]!.execute("call", { questions: [{ question: "Choose", options: [{ label: "Alpha" }] }] }, undefined, undefined, ctx);
  const permission = await tools[1]!.execute("call", { permission: "write", patterns: ["*.docx"] }, undefined, undefined, ctx);
  const permissionAgain = await tools[1]!.execute("call", { permission: "write", patterns: ["*.docx"] }, undefined, undefined, ctx);
  assert.match(question.content[0].text, /Alpha/);
  assert.match(permission.content[0].text, /permanently approved/);
  assert.match(permissionAgain.content[0].text, /permanently approved/);
  assert.equal(selections.length, 2);
  assert.deepEqual(selections[1], { title: 'Permission: write [patterns: ["*.docx"]]', options: ["Once", "Always", "Reject"] });
});

test("Pi mapper replays the real tool fixture without leaking thinking", () => {
  const state = createPiMappingState();
  const events: EngineEvent[] = readFileSync("spikes/phase0/fixtures/pi-tool-read.raw.jsonl", "utf8").trim().split(/\r?\n/).flatMap((line: string) => mapPiEvent(JSON.parse(line) as unknown, state));
  const text = events.filter((event): event is Extract<EngineEvent, { type: "text.delta" }> => event.type === "text.delta").map((event) => event.delta).join("");
  assert.equal(text, "I'll read the first line of that file.# 多 Agent 引擎可替换网关 SPEC");
  assert.equal(events.filter((event) => event.type === "run.started").length, 1);
  assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
  assert.deepEqual(events.filter((event) => event.type === "tool.started"), [{ type: "tool.started", callRef: "call_00_ET_5w9rNlhZFXDyreUacuF25253", name: "read" }]);
  assert.deepEqual(events.filter((event) => event.type === "tool.updated"), [{ type: "tool.updated", callRef: "call_00_ET_5w9rNlhZFXDyreUacuF25253", args: { path: "docs/多Agent引擎可替换网关-SPEC.md", limit: 1 } }]);
});

test("Pi mapper maps extension UI dialogs and ignores reasoning", () => {
  const state = createPiMappingState();
  assert.deepEqual(mapPiEvent({ type: "agent_start" }, state), [{ type: "run.started" }]);
  assert.deepEqual(mapPiEvent({ type: "extension_ui_request", id: "perm_1", method: "confirm", title: "Allow bash" }, state), [{ type: "permission.requested", interactionRef: { opaqueId: "perm_1" }, permission: "Allow bash", patterns: [] }]);
  assert.deepEqual(mapPiEvent({ type: "extension_ui_request", id: "perm_2", method: "select", title: 'Permission: write [patterns: ["*.docx", "src/**"]]', options: ["Once", "Always", "Reject"] }, state), [{ type: "permission.requested", interactionRef: { opaqueId: "perm_2" }, permission: "write", patterns: ["*.docx", "src/**"] }]);
  assert.deepEqual(mapPiEvent({ type: "extension_ui_request", id: "question_1", method: "select", title: "Choose", options: ["A", "B"] }, state), [{ type: "question.requested", interactionRef: { opaqueId: "question_1" }, questions: [{ question: "Choose", options: [{ label: "A" }, { label: "B" }] }] }]);
  assert.deepEqual(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } }, state), []);
  assert.deepEqual(mapPiEvent({ type: "agent_settled" }, state), [{ type: "run.settled" }]);
});

test("Pi mapper treats agent_end as non-terminal and waits for agent_settled", () => {
  const state = createPiMappingState();
  mapPiEvent({ type: "agent_start" }, state);
  assert.deepEqual(mapPiEvent({ type: "agent_end" }, state), []);
  assert.deepEqual(mapPiEvent({ type: "agent_settled" }, state), [{ type: "run.settled" }]);
});

test("Pi adapter loads the production bridge and handles chunked CRLF RPC", async () => {
  const { adapter, args, commands } = createMockAdapter("chunked");
  const session = await startMock(adapter);
  assert.deepEqual(commands, [process.execPath]);
  assert.equal(args[0]?.endsWith("@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js") || args[0]?.endsWith("@earendil-works/pi-coding-agent/dist/bundle/cli.js"), true);
  assert.equal(args[args.indexOf("--extension") + 1]?.endsWith("gateway-bridge.ts") || args[args.indexOf("--extension") + 1]?.endsWith("gateway-bridge.js"), true);
  const events: unknown[] = [];
  const result = await adapter.run(session, { gatewayRunId: "run_chunked", text: "继续", model: { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" } }, async (event) => { events.push(event); }, new AbortController().signal);
  assert.deepEqual(result, { state: "completed" });
  assert.deepEqual(events, [{ type: "run.started" }, { type: "text.delta", messageRef: "assistant-0", delta: "完成" }, { type: "run.settled" }]);
});

test("Pi adapter bridges question and permission replies as notifications", async () => {
  for (const [mode, kind] of [["question", "question"], ["permission", "permission"]] as const) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-reply-test-"));
    const replyFile = path.join(temp, "reply.json");
    const { adapter } = createMockAdapter(mode, undefined, undefined, replyFile);
    const session = await startMock(adapter);
    const events: Array<{ type: string; interactionRef?: { opaqueId: string } }> = [];
    const run = adapter.run(session, { gatewayRunId: `run_${mode}`, text: "需要交互", model: { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" } }, async (event) => {
      events.push(event as typeof events[number]);
      if (event.type === "question.requested") await adapter.replyQuestion(session, event.interactionRef, [["Alpha"]]);
      if (event.type === "permission.requested") await adapter.replyPermission(session, event.interactionRef, { reply: "always" });
    }, new AbortController().signal);
    assert.deepEqual(await run, { state: "completed" });
    assert.equal(events.some((event) => event.type === `${kind}.requested`), true);
    if (kind === "permission") assert.equal(JSON.parse(readFileSync(replyFile, "utf8")).value, "Always");
    await adapter.deleteSession(session);
    await rm(temp, { recursive: true, force: true });
  }
});

test("Pi adapter translates prompt timeout, invalid JSONL, and process exit", async () => {
  for (const mode of ["timeout", "invalid", "exit"] as const) {
    const { adapter } = createMockAdapter(mode);
    const session = await startMock(adapter);
    const events: unknown[] = [];
    const result = await adapter.run(session, { gatewayRunId: `run_${mode}`, text: "失败路径", model: { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" } }, async (event) => { events.push(event); }, new AbortController().signal);
    assert.equal(result.state, "failed");
    assert.equal(events.some((event) => (event as { type?: string }).type === "run.failed"), true);
    await adapter.deleteSession(session);
  }
});

test("Pi adapter coalesces concurrent abort requests and isolates late settlement", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-test-"));
  const countFile = path.join(temp, "abort-count.txt");
  try {
    const { adapter } = createMockAdapter("abort-settled-first", countFile);
    const session = await startMock(adapter);
    const controller = new AbortController();
    const events: unknown[] = [];
    const run = adapter.run(session, { gatewayRunId: "run_abort", text: "中止", model: { providerId: "mock-provider", modelId: "mock-model", credentialRef: "none" } }, async (event) => { events.push(event); if (event.type === "run.started") controller.abort(); }, controller.signal);
    const result = await Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort test timed out")), 1_000))]);
    assert.deepEqual(result, { state: "aborted" });
    assert.equal(events.some((event) => (event as { type?: string }).type === "run.settled"), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readFileSync(countFile, "utf8"), "1");
    await adapter.deleteSession(session);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Pi adapter deletes the RPC child process", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-process-test-"));
  const pidFile = path.join(temp, "pid.txt");
  try {
    const { adapter } = createMockAdapter("complete", undefined, pidFile);
    const session = await startMock(adapter);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    await adapter.deleteSession(session);
    const deadline = Date.now() + 1_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); }
      catch { alive = false; }
    }
    assert.equal(alive, false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
