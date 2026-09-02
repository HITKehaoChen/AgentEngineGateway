import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { buildOpenCodeConfig, OpenCodeAdapter } from "../src/harness/opencode/adapter.js";
import { createOpenCodeMappingState, mapOpenCodeEvent } from "../src/harness/opencode/event-mapper.js";
import { consumeSse } from "../src/harness/opencode/sse.js";
import { InteractionBroker } from "../src/gateway/interaction-broker.js";
import type { GatewaySession, HarnessAdapter } from "../src/model/types.js";

test("OpenCode mapper converts golden interaction and tool events", () => {
  const state = createOpenCodeMappingState();
  const map = (event: unknown) => mapOpenCodeEvent(event, state);
  assert.deepEqual(map({ id: "1", type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }), [{ type: "run.started" }]);
  assert.deepEqual(map({ id: "reasoning", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "reasoning_1", messageID: "msg_1", type: "reasoning", text: "内部推理" } } }), []);
  assert.deepEqual(map({ id: "reasoning-delta", type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "reasoning_1", field: "text", delta: "不应泄漏" } }), []);
  assert.deepEqual(map({ id: "text-start", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "prt_1", messageID: "msg_1", type: "text", text: "" } } }), []);
  assert.deepEqual(map({ id: "2", type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "你好" } }), [{ type: "text.delta", messageRef: "msg_1", delta: "你好" }]);
  assert.deepEqual(map({ id: "pending", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "tool_0", messageID: "msg_1", type: "tool", tool: "bash", callID: "call_0", state: { status: "pending", input: {} } } } }), [{ type: "tool.started", callRef: "call_0", name: "bash", args: {} }]);
  assert.deepEqual(map({ id: "running", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "tool_0", messageID: "msg_1", type: "tool", tool: "bash", callID: "call_0", state: { status: "running", input: { command: "echo ok" } } } } }), [{ type: "tool.updated", callRef: "call_0", args: { command: "echo ok" } }]);
  assert.deepEqual(map({ id: "3", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "read", callID: "call_1", state: { status: "running", input: { filePath: "C:\\中文.txt" }, title: "读取" } } } }), [{ type: "tool.started", callRef: "call_1", name: "read", title: "读取", args: { filePath: "C:\\中文.txt" } }]);
  assert.deepEqual(map({ id: "4", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "tool_1", messageID: "msg_1", type: "tool", tool: "read", callID: "call_1", state: { status: "completed", output: "文件内容", title: "完成" } } } }), [{ type: "tool.completed", callRef: "call_1", title: "完成", output: "文件内容", isError: false }]);
  assert.deepEqual(map({ id: "5", type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "step_1", messageID: "msg_1", type: "step-finish", reason: "tool-calls" } } }), [{ type: "step.finished", finish: "tool-calls" }]);
  assert.deepEqual(map({ id: "6", type: "question.asked", properties: { sessionID: "ses_1", id: "que_1", questions: [{ question: "选择", options: [{ label: "甲", description: "第一项" }] }] } }), [{ type: "question.requested", interactionRef: { opaqueId: "que_1" }, questions: [{ question: "选择", options: [{ label: "甲", description: "第一项" }] }] }]);
  assert.deepEqual(map({ id: "7", type: "permission.asked", properties: { sessionID: "ses_1", id: "per_1", permission: "bash", patterns: ["*"] } }), [{ type: "permission.requested", interactionRef: { opaqueId: "per_1" }, permission: "bash", patterns: ["*"] }]);
  assert.deepEqual(map({ id: "8", type: "session.idle", properties: { sessionID: "ses_1" } }), [{ type: "run.settled" }]);
  assert.deepEqual(map({ id: "8", type: "session.idle", properties: { sessionID: "ses_1" } }), []);
});

test("Phase 0 OpenCode fixture replay excludes reasoning and preserves pending tool input", () => {
  const rows = readFileSync("spikes/phase0/fixtures/opencode-server-interactions.raw.jsonl", "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  const states = new Map<string, ReturnType<typeof createOpenCodeMappingState>>();
  const events = rows.flatMap((row) => {
    const value = row as { properties?: { sessionID?: unknown } };
    const sessionId = typeof value.properties?.sessionID === "string" ? value.properties.sessionID : undefined;
    if (!sessionId) return [];
    const state = states.get(sessionId) ?? createOpenCodeMappingState();
    states.set(sessionId, state);
    return mapOpenCodeEvent(row, state);
  });
  const text = events.filter((event): event is Extract<typeof event, { type: "text.delta" }> => event.type === "text.delta").map((event) => event.delta).join("");
  assert.doesNotMatch(text, /The user wants me to/);
  const bash = events.find((event): event is Extract<typeof event, { type: "tool.updated" }> => event.type === "tool.updated" && event.callRef === "call_00_DmaasBVHbx1uq9LVUAnu8015");
  assert.deepEqual(bash?.args, { command: 'powershell -NoProfile -Command "Write-Output PHASE0_PERMISSION_OK"' });
});

test("OpenCode runtime config wires endpoint and env credential without writing the secret", () => {
  const config = buildOpenCodeConfig({ providerId: "glm", modelId: "glm-5.2", baseUrl: "https://glm.example/v1", credentialRef: "env:MODEL_API_KEY" });
  const glm = config.provider.glm;
  assert.ok(glm);
  assert.deepEqual(glm.options, { baseURL: "https://glm.example/v1", apiKey: "{env:MODEL_API_KEY}" });
  assert.equal(JSON.stringify(config).includes("MODEL_API_KEY_VALUE"), false);
  assert.deepEqual(glm.models, { "glm-5.2": { name: "glm-5.2" } });
});

test("SSE parser dispatches CRLF frames, split boundaries, and multiline data", async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"n\":\r"));
      controller.enqueue(encoder.encode("\ndata: 1}\r\n\r"));
      controller.enqueue(encoder.encode("\ndata: 2\r\n\r\n"));
      controller.close();
    },
  }));
  const values: unknown[] = [];
  await consumeSse(response, async (data) => { values.push(JSON.parse(data)); });
  assert.deepEqual(values, [{ n: 1 }, 2]);
});

test("interaction reply remains pending when upstream reply fails", async () => {
  let fail = true;
  const adapter = { replyQuestion: async () => { if (fail) throw { code: "UPSTREAM_ERROR", message: "temporary failure", retryable: true }; } } as unknown as HarnessAdapter;
  const broker = new InteractionBroker(adapter);
  const session = { id: "ses_gateway", pendingInteractionIds: [] } as unknown as GatewaySession;
  const interaction = broker.create(session, "run_1", { type: "question.requested", interactionRef: { opaqueId: "que_1" }, questions: [{ question: "选择", options: [] }] });
  await assert.rejects(broker.replyQuestion(interaction.id, [["A"]], session), (error: unknown) => Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 502));
  assert.equal(broker.questions().length, 1);
  fail = false;
  await broker.replyQuestion(interaction.id, [["A"]], session);
  assert.equal(broker.questions().length, 0);
});

test("OpenCode adapter runs through HTTP/SSE and preserves Chinese Windows context", async () => {
  let eventResponse: http.ServerResponse | undefined;
  let promptBody: Record<string, unknown> | undefined;
  let promptUrl = "";
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/doc" || url.pathname === "/global/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ healthy: true, version: "1.18.26" })); return; }
    if (url.pathname === "/event") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); eventResponse = response; return; }
    if (url.pathname === "/session" && request.method === "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "ses_mock" })); return; }
    if (url.pathname === "/session/ses_mock/prompt_async") {
      promptUrl = request.url ?? "";
      promptBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      response.writeHead(204); response.end();
      const send = (value: unknown) => eventResponse?.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ id: "1", type: "session.status", properties: { sessionID: "ses_mock", status: { type: "busy" } } });
      send({ id: "text-start", type: "message.part.updated", properties: { sessionID: "ses_mock", part: { id: "part_mock", messageID: "msg_mock", type: "text", text: "" } } });
      send({ id: "2", type: "message.part.delta", properties: { sessionID: "ses_mock", messageID: "msg_mock", partID: "part_mock", field: "text", delta: "完成" } });
      send({ id: "3", type: "session.status", properties: { sessionID: "ses_mock", status: { type: "idle" } } });
      return;
    }
    if (url.pathname === "/session/ses_mock/abort") { response.writeHead(200, { "content-type": "application/json" }); response.end("true"); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, expectedVersion: "1.18.26" });
  try {
    await adapter.start({ command: "opencode", version: "1.18.26", model: { providerId: "glm", modelId: "glm-5.2", credentialRef: "none" }, startupTimeoutMs: 1_000, healthTimeoutMs: 100 });
    const session = await adapter.createSession({ gatewaySessionId: "ses_gateway", title: "中文任务", directory: "C:\\工作区\\中文" });
    const events: unknown[] = [];
    const result = await adapter.run(session, { gatewayRunId: "run_1", text: "读取 C:\\中文.txt", model: { providerId: "glm", modelId: "glm-5.2", credentialRef: "none" } }, async (event) => { events.push(event); }, new AbortController().signal);
    assert.deepEqual(result, { state: "completed" });
    assert.equal(new URLSearchParams(promptUrl.split("?")[1]).get("directory"), "C:\\工作区\\中文");
    assert.deepEqual(promptBody, { parts: [{ type: "text", text: "读取 C:\\中文.txt" }], model: { providerID: "glm", modelID: "glm-5.2" } });
    assert.deepEqual(events, [{ type: "run.started" }, { type: "text.delta", messageRef: "msg_mock", delta: "完成" }, { type: "run.settled" }]);
  } finally {
    await adapter.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenCode SSE loss aborts the upstream run and quarantines the session until idle", async () => {
  let eventResponse: http.ServerResponse | undefined;
  let abortCalls = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/global/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ healthy: true, version: "1.18.26" })); return; }
    if (url.pathname === "/event") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); eventResponse = response; return; }
    if (url.pathname === "/session" && request.method === "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "ses_loss" })); return; }
    if (url.pathname === "/session/ses_loss/prompt_async") {
      response.writeHead(204); response.end();
      eventResponse?.write(`data: ${JSON.stringify({ id: "busy", type: "session.status", properties: { sessionID: "ses_loss", status: { type: "busy" } } })}\n\n`);
      setTimeout(() => eventResponse?.destroy(), 10);
      return;
    }
    if (url.pathname === "/session/ses_loss/abort") { abortCalls += 1; request.on("close", () => undefined); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, expectedVersion: "1.18.26", controlTimeoutMs: 50 });
  try {
    const model = { providerId: "glm", modelId: "glm-5.2", credentialRef: "none" };
    await adapter.start({ command: "opencode", version: "1.18.26", model, startupTimeoutMs: 1_000, healthTimeoutMs: 100 });
    const session = await adapter.createSession({ gatewaySessionId: "ses_gateway", title: "断流", directory: "C:\\工作区" });
    const events: unknown[] = [];
    const result = await adapter.run(session, { gatewayRunId: "run_loss", text: "继续", model }, async (event) => { events.push(event); }, new AbortController().signal);
    assert.equal(result.state, "failed");
    assert.equal(result.state === "failed" ? result.error.code : "", "UNAVAILABLE");
    assert.ok(abortCalls >= 1);
    const retryEvents: unknown[] = [];
    const retry = await adapter.run(session, { gatewayRunId: "run_retry", text: "重试", model }, async (event) => { retryEvents.push(event); }, new AbortController().signal);
    assert.equal(retry.state, "failed");
    assert.deepEqual(retryEvents, [{ type: "run.failed", error: { code: "UNAVAILABLE", message: "OpenCode session is quarantined after an unconfirmed abort", retryable: true } }]);
    assert.ok(events.some((event) => (event as { type?: unknown }).type === "run.failed"));
  } finally {
    await adapter.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
