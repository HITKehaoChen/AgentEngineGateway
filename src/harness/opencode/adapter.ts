import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineConfig, EngineError, EngineEvent, EngineEventSink, EngineInteractionRef, EngineSessionRef, HarnessAdapter, PermissionDecision, RunInput, RunResult, SessionContext } from "../../model/types.js";
import { OpenCodeClient, OpenCodeHttpError } from "./client.js";
import { createOpenCodeMappingState, mapOpenCodeEvent } from "./event-mapper.js";
import { consumeSse } from "./sse.js";

export interface OpenCodeAdapterOptions {
  command?: string;
  hostname?: string;
  port?: number;
  baseUrl?: string;
  expectedVersion?: string;
  controlTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface SessionHandle { directory: string }
interface ActiveRun {
  sessionId: string;
  directory: string;
  sink: EngineEventSink;
  signal: AbortSignal;
  mapping: ReturnType<typeof createOpenCodeMappingState>;
  resolve: (result: RunResult) => void;
  finished: boolean;
  abortListener: () => void;
}

/** OpenCode's HTTP/SSE protocol is deliberately contained in this adapter. */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly name = "opencode";
  private readonly options: OpenCodeAdapterOptions;
  private client: OpenCodeClient | undefined;
  private child: ChildProcess | undefined;
  private started = false;
  private stopping = false;
  private version = "unknown";
  private expectedVersion = "";
  private healthTimeoutMs = 5_000;
  private controlTimeoutMs = 5_000;
  private generatedConfigDir: string | undefined;
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly eventStreams = new Map<string, { abort: AbortController; task: Promise<void> }>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly quarantined = new Set<string>();

  constructor(options: OpenCodeAdapterOptions = {}) { this.options = options; }

  async start(config: EngineConfig): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    const baseUrl = this.options.baseUrl ?? `http://${this.options.hostname ?? "127.0.0.1"}:${this.options.port ?? 6221}`;
    this.client = new OpenCodeClient(baseUrl, this.options.fetchImpl);
    const expectedVersion = this.options.expectedVersion ?? config.version;
    this.expectedVersion = expectedVersion;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.controlTimeoutMs = this.options.controlTimeoutMs ?? config.healthTimeoutMs;
    if (!this.options.baseUrl) {
      await this.prepareOpenCodeConfig(config.model);
      const command = normalizeCommand(this.options.command ?? config.command);
      const actualVersion = commandVersion(command);
      if (actualVersion && expectedVersion && actualVersion !== expectedVersion) {
        await this.removeGeneratedConfig();
        this.client = undefined;
        throw new Error(`OpenCode version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
      }
      this.version = actualVersion || expectedVersion || "unknown";
      const port = this.options.port ?? 6221;
      this.child = spawn(command, ["serve", "--hostname", this.options.hostname ?? "127.0.0.1", "--port", String(port), "--pure"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: this.childEnvironment(), ...(process.platform === "win32" && /\.(cmd|bat)$/i.test(command) ? { shell: true } : {}) });
      this.child.stderr?.resume();
      this.child.once("error", (error) => { if (!this.stopping) void this.failActive(engineError("UNAVAILABLE", "OpenCode process failed", error)); });
      this.child.once("exit", () => { if (!this.stopping) void this.failActive(engineError("UNAVAILABLE", "OpenCode process exited")); });
    } else {
      this.version = expectedVersion || "unknown";
    }
    try { await this.waitForHealth(config.startupTimeoutMs); }
    catch (error) {
      this.stopping = true;
      const child = this.child;
      this.child = undefined;
      if (child && child.exitCode === null) await terminateProcessTree(child);
      await this.removeGeneratedConfig();
      this.client = undefined;
      this.stopping = false;
      throw error;
    }
    this.started = true;
  }

  async health(): Promise<{ ok: boolean; version: string; message?: string }> {
    if (!this.client) return { ok: false, version: this.version, message: "OpenCode is not started" };
    try {
      const value = await this.client.request<{ healthy?: unknown; version?: unknown }>("GET", "/global/health", { timeoutMs: this.healthTimeoutMs });
      const version = typeof value?.version === "string" ? value.version : this.version;
      if (value?.healthy === false) return { ok: false, version, message: "OpenCode reports unhealthy" };
      if (this.expectedVersion && version !== "unknown" && version !== this.expectedVersion) return { ok: false, version, message: `OpenCode version mismatch: expected ${this.expectedVersion}, got ${version}` };
      this.version = version;
      return { ok: true, version };
    }
    catch (error) { return { ok: false, version: this.version, message: safeMessage(error) }; }
  }

  async createSession(context: SessionContext): Promise<EngineSessionRef> {
    const client = this.requireClient();
    try {
      const session = await client.request<{ id?: unknown }>("POST", "/session", { query: { directory: context.directory }, body: { title: context.title }, timeoutMs: this.controlTimeoutMs });
      if (!session || typeof session.id !== "string" || !session.id) throw new Error("OpenCode returned an invalid session");
      this.sessions.set(session.id, { directory: context.directory });
      try { await this.ensureEventStream(context.directory); }
      catch (error) {
        this.sessions.delete(session.id);
        try { await client.request<unknown>("DELETE", `/session/${encodeURIComponent(session.id)}`, { query: { directory: context.directory }, timeoutMs: this.controlTimeoutMs }); } catch { /* best effort */ }
        throw error;
      }
      return { opaqueId: session.id };
    } catch (error) { throw toAdapterError(error, "OpenCode session creation failed"); }
  }

  async run(session: EngineSessionRef, input: RunInput, sink: EngineEventSink, signal: AbortSignal): Promise<RunResult> {
    const handle = this.requireSession(session);
    if (this.quarantined.has(session.opaqueId)) {
      const error=engineError("UNAVAILABLE","OpenCode session is quarantined after an unconfirmed abort");
      try { await sink({type:"run.failed",error}); } catch { /* Coordinator will still receive the failed result. */ }
      return {state:"failed",error};
    }
    if (this.active.has(session.opaqueId)) return { state: "failed", error: engineError("INTERNAL", "OpenCode session already has an active run") };
    return new Promise<RunResult>((resolve) => {
      const active: ActiveRun = { sessionId: session.opaqueId, directory: handle.directory, sink, signal, mapping: createOpenCodeMappingState(), resolve, finished: false, abortListener: () => { void this.cancelRun(active); } };
      this.active.set(session.opaqueId, active);
      signal.addEventListener("abort", active.abortListener, { once: true });
      void this.sendPrompt(active, input);
    });
  }

  async replyQuestion(session: EngineSessionRef, interaction: EngineInteractionRef, answers: string[][]): Promise<void> {
    await this.reply(session, `/question/${encodeURIComponent(interaction.opaqueId)}/reply`, { answers });
  }

  async replyPermission(session: EngineSessionRef, interaction: EngineInteractionRef, decision: PermissionDecision): Promise<void> {
    await this.reply(session, `/permission/${encodeURIComponent(interaction.opaqueId)}/reply`, decision);
  }

  async abort(session: EngineSessionRef): Promise<void> {
    await this.abortSession(session);
  }

  private async abortSession(session: EngineSessionRef): Promise<void> {
    const handle = this.sessions.get(session.opaqueId);
    if (!handle || !this.client) return;
    try { await this.client.request<unknown>("POST", `/session/${encodeURIComponent(session.opaqueId)}/abort`, { query: { directory: handle.directory }, body: {}, timeoutMs: this.controlTimeoutMs }); }
    catch (error) { if (!(error instanceof OpenCodeHttpError && error.status === 404)) throw toAdapterError(error, "OpenCode abort failed"); }
  }

  async deleteSession(session: EngineSessionRef): Promise<void> {
    const handle = this.sessions.get(session.opaqueId);
    this.sessions.delete(session.opaqueId);
    this.quarantined.delete(session.opaqueId);
    if (handle && ![...this.sessions.values()].some((value) => value.directory === handle.directory)) this.closeEventStream(handle.directory);
    if (!handle || !this.client) return;
    try { await this.client.request<unknown>("DELETE", `/session/${encodeURIComponent(session.opaqueId)}`, { query: { directory: handle.directory }, timeoutMs: this.controlTimeoutMs }); }
    catch (error) { if (!(error instanceof OpenCodeHttpError && error.status === 404)) throw toAdapterError(error, "OpenCode session deletion failed"); }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const stream of this.eventStreams.values()) stream.abort.abort();
    this.eventStreams.clear();
    this.quarantined.clear();
    for (const active of [...this.active.values()]) await this.finish(active, { state: "aborted" });
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) await terminateProcessTree(child);
    await this.removeGeneratedConfig();
    this.started = false;
    this.client = undefined;
    this.sessions.clear();
  }

  private async prepareOpenCodeConfig(model: EngineConfig["model"]): Promise<void> {
    if (process.env.OPENCODE_CONFIG || this.generatedConfigDir) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-gateway-opencode-"));
    const provider = buildOpenCodeConfig(model).provider[model.providerId];
    try {
      await writeFile(path.join(dir, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { [model.providerId]: provider } }, null, 2)}\n`, "utf8");
      this.generatedConfigDir = dir;
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }

  private async removeGeneratedConfig(): Promise<void> {
    const dir = this.generatedConfigDir;
    this.generatedConfigDir = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    return this.generatedConfigDir ? { ...process.env, OPENCODE_CONFIG: path.join(this.generatedConfigDir, "opencode.json") } : { ...process.env };
  }

  private async sendPrompt(active: ActiveRun, input: RunInput): Promise<void> {
    if (active.signal.aborted) return this.finish(active, { state: "aborted" });
    try {
      await this.requireClient().request<unknown>("POST", `/session/${encodeURIComponent(active.sessionId)}/prompt_async`, { query: { directory: active.directory }, body: { parts: [{ type: "text", text: input.text }], model: { providerID: input.model.providerId, modelID: input.model.modelId } }, signal: active.signal, timeoutMs: this.controlTimeoutMs });
    } catch (error) {
      if (active.signal.aborted) return this.finish(active, { state: "aborted" });
      const translated = toAdapterError(error, "OpenCode prompt failed");
      await this.emitTerminal(active, { type: "run.failed", error: translated });
    }
  }

  private async ensureEventStream(directory: string): Promise<void> {
    if (this.eventStreams.has(directory)) return;
    const abort = new AbortController();
    let connected!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
    const task = this.consumeEvents(directory, abort.signal, connected, failed);
    this.eventStreams.set(directory, { abort, task });
    const timer = setTimeout(() => failed(new Error("OpenCode event stream connection timed out")), this.healthTimeoutMs);
    try { await ready; }
    catch (error) { abort.abort(); this.eventStreams.delete(directory); await task; throw error; }
    finally { clearTimeout(timer); }
  }

  private async consumeEvents(directory: string, signal: AbortSignal, connected: () => void, failed: (error: unknown) => void): Promise<void> {
    let firstConnection = true;
    while (!signal.aborted && !this.stopping) {
      try {
        const response = await this.requireClient().stream("/event", { query: { directory }, signal });
        if (firstConnection) { firstConnection = false; connected(); }
        await consumeSse(response, async (data) => {
          let raw: unknown;
          try { raw = JSON.parse(data); } catch (error) { throw engineError("INTERNAL", "OpenCode emitted invalid JSON", error); }
          const sessionId = sessionIdOf(raw);
          if (sessionId && isIdleEvent(raw)) this.quarantined.delete(sessionId);
          const active = sessionId ? this.active.get(sessionId) : undefined;
          if (!active || active.directory !== directory) return;
          for (const event of mapOpenCodeEvent(raw, active.mapping)) await this.emit(active, event);
        });
        if (!signal.aborted && !this.stopping) throw new Error("OpenCode event stream ended");
      } catch (error) {
        if (signal.aborted || this.stopping) return;
        if (firstConnection) { failed(error); return; }
        const canonical = error && typeof error === "object" && "code" in error ? error as EngineError : engineError("UNAVAILABLE", "OpenCode event stream failed", error);
        await this.failActive(canonical, directory);
        await delay(250, signal);
      }
    }
  }

  private async emit(active: ActiveRun, event: EngineEvent): Promise<void> {
    if (active.finished) return;
    try { await active.sink(event); }
    catch (error) {
      await this.finish(active, { state: "failed", error: engineError("INTERNAL", "Gateway event sink failed", error) });
      try { await this.abort({ opaqueId: active.sessionId }); } catch { /* best effort */ }
      return;
    }
    if (event.type === "run.settled") return this.finish(active, { state: "completed" });
    if (event.type === "run.failed") return this.finish(active, { state: "failed", error: event.error });
    if (event.type === "run.aborted") return this.finish(active, { state: "aborted" });
  }

  private async emitTerminal(active: ActiveRun, event: Extract<EngineEvent, { type: "run.failed" | "run.aborted" }>): Promise<void> { await this.emit(active, event); }

  private async cancelRun(active: ActiveRun): Promise<void> {
    if (active.finished) return;
    this.quarantined.add(active.sessionId);
    try { await this.abortSession({ opaqueId: active.sessionId }); } catch { /* Coordinator owns the public error; cancellation is best effort. */ }
    await this.emitTerminal(active, { type: "run.aborted" });
  }

  private async finish(active: ActiveRun, result: RunResult): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    active.signal.removeEventListener("abort", active.abortListener);
    this.active.delete(active.sessionId);
    active.resolve(result);
  }

  private async failActive(error: EngineError, directory?: string): Promise<void> {
    for (const active of [...this.active.values()]) if (directory === undefined || active.directory === directory) {
      this.quarantined.add(active.sessionId);
      try { await this.abortSession({opaqueId:active.sessionId}); } catch { /* Keep the session quarantined until a later idle event. */ }
      await this.emitTerminal(active, { type: "run.failed", error });
    }
  }

  private closeEventStream(directory: string): void { const stream = this.eventStreams.get(directory); if (stream) { stream.abort.abort(); this.eventStreams.delete(directory); } }

  private async reply(session: EngineSessionRef, route: string, body: unknown): Promise<void> {
    const handle = this.requireSession(session);
    try { await this.requireClient().request<unknown>("POST", route, { query: { directory: handle.directory }, body, timeoutMs: this.controlTimeoutMs }); }
    catch (error) { throw toAdapterError(error, "OpenCode interaction reply failed"); }
  }

  private requireClient(): OpenCodeClient { if (!this.client || !this.started && !this.child && !this.options.baseUrl) throw new Error("OpenCode is not started"); return this.client; }
  private requireSession(session: EngineSessionRef): SessionHandle { const handle = this.sessions.get(session.opaqueId); if (!handle) throw new Error("Unknown OpenCode session"); return handle; }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try { const health = await this.health(); if (health.ok) return; last = health.message; }
      catch (error) { last = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`OpenCode did not become healthy: ${safeMessage(last)}`);
  }
}

export function buildOpenCodeConfig(model: EngineConfig["model"]): { provider: Record<string, { npm: string; name: string; options: Record<string, string>; models: Record<string, { name: string }> }> } {
  const credentialEnv = model.credentialRef.startsWith("env:") ? model.credentialRef.slice(4) : undefined;
  return {
    provider: {
      [model.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `Gateway ${model.providerId}`,
        options: { ...(model.baseUrl ? { baseURL: model.baseUrl } : {}), ...(credentialEnv ? { apiKey: `{env:${credentialEnv}}` } : {}) },
        models: { [model.modelId]: { name: model.modelId } },
      },
    },
  };
}

function normalizeCommand(command: string): string {
  if (process.platform === "win32" && (command === "opencode" || command.endsWith("/opencode") || command.endsWith("\\opencode"))) {
    const candidates = [path.resolve("node_modules/opencode-ai/bin/opencode.exe"), process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe") : ""];
    const executable = candidates.find((candidate) => candidate && existsSync(candidate));
    if (executable) return executable;
    if (!/\.(cmd|exe|bat)$/i.test(command)) return `${command}.cmd`;
  }
  return command;
}

function commandVersion(command: string): string | undefined {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.status !== 0) return undefined;
  const value = `${result.stdout ?? ""}`.trim().split(/\s+/)[0] ?? "";
  return /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); killer.once("close", () => resolve()); killer.once("error", () => resolve()); });
  } else child.kill("SIGTERM");
}

function sessionIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const properties = (value as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && typeof (properties as { sessionID?: unknown }).sessionID === "string" ? (properties as { sessionID: string }).sessionID : undefined;
}
function isIdleEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (type === "session.idle") return true;
  if (type !== "session.status") return false;
  const status = (value as { properties?: { status?: { type?: unknown } } }).properties?.status?.type;
  return status === "idle";
}

function engineError(code: EngineError["code"], message: string, cause?: unknown): EngineError { return { code, message, retryable: code !== "INTERNAL", ...(cause === undefined ? {} : { cause }) }; }
function toAdapterError(error: unknown, fallback: string): EngineError {
  if (error instanceof OpenCodeHttpError) {
    if (error.status === 400) return engineError("INVALID_REQUEST", fallback, error);
    if (error.status === 404) return engineError("INVALID_REQUEST", "OpenCode resource was not found", error);
    if (error.status === 503) return engineError("UNAVAILABLE", "OpenCode is unavailable", error);
    return engineError("UPSTREAM_ERROR", fallback, error);
  }
  if (error instanceof Error && error.name === "AbortError") return engineError("TIMEOUT", "OpenCode request timed out", error);
  return engineError("UPSTREAM_ERROR", error instanceof Error ? error.message : fallback, error);
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : "OpenCode health check failed"; }
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => { clearTimeout(timer); done(); };
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
