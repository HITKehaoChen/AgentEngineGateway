import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { EngineConfig, EngineError, EngineEvent, EngineEventSink, EngineInteractionRef, EngineSessionRef, HarnessAdapter, PermissionDecision, RunInput, RunResult, SessionContext } from "../../model/types.js";
import { createPiMappingState, mapPiEvent, markPiAborted, type PiMappingState } from "./event-mapper.js";

export interface PiAdapterOptions {
  command?: string;
  bridgePath?: string;
  expectedVersion?: string;
  controlTimeoutMs?: number;
  abortGraceMs?: number;
  spawnImpl?: typeof spawn;
}

interface PendingResponse { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
interface PendingInteraction { kind: "question" | "permission"; request: Record<string, unknown> }
interface ActiveRun {
  input: RunInput;
  sink: EngineEventSink;
  signal: AbortSignal;
  mapping: PiMappingState;
  resolve: (result: RunResult) => void;
  finished: boolean;
  abortListener: () => void;
}
interface PiSession {
  context: SessionContext;
  child: ChildProcess;
  buffer: string;
  dispatch: Promise<void>;
  pending: Map<string, PendingResponse>;
  interactions: Map<string, PendingInteraction>;
  active: ActiveRun | undefined;
  quarantined: boolean;
  abortRequested: boolean;
  abortPromise: Promise<void> | undefined;
  closed: boolean;
}
interface PiCommand { executable: string; args: string[] }

/** Pi's RPC protocol is intentionally isolated here; the Gateway only sees HarnessAdapter. */
export class PiAdapter implements HarnessAdapter {
  readonly name = "pi";
  private readonly options: PiAdapterOptions;
  private readonly sessions = new Map<string, PiSession>();
  private started = false;
  private stopping = false;
  private commandPath = "pi";
  private commandArgs: string[] = [];
  private version = "unknown";
  private expectedVersion = "";
  private config: EngineConfig | undefined;
  private generatedConfigDir: string | undefined;
  private bridgePath = "";

  constructor(options: PiAdapterOptions = {}) { this.options = options; }

  async start(config: EngineConfig): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    this.config = config;
    this.expectedVersion = this.options.expectedVersion ?? config.version;
    const command = normalizeCommand(this.options.command ?? config.command);
    this.commandPath = command.executable;
    this.commandArgs = command.args;
    const actualVersion = commandVersion(command);
    if (actualVersion && this.expectedVersion && actualVersion !== this.expectedVersion) throw new Error(`Pi version mismatch: expected ${this.expectedVersion}, got ${actualVersion}`);
    if (!actualVersion && this.expectedVersion) throw new Error(`Pi executable is unavailable or did not report a version: ${this.commandPath}`);
    this.version = actualVersion ?? this.expectedVersion ?? "unknown";
    this.bridgePath = this.options.bridgePath ?? resolveBridgePath();
    if (!existsSync(this.bridgePath)) throw new Error(`Pi Gateway Bridge was not found: ${this.bridgePath}`);
    await this.preparePiConfig(config.model);
    this.started = true;
  }

  async health(): Promise<{ ok: boolean; version: string; message?: string }> {
    if (!this.started || this.stopping) return { ok: false, version: this.version, message: "Pi is not started" };
    return { ok: true, version: this.version };
  }

  async createSession(context: SessionContext): Promise<EngineSessionRef> {
    if (!this.started || this.stopping || !this.config) throw new Error("Pi is not started");
    const child = this.spawnProcess(context, this.config);
    const session: PiSession = { context, child, buffer: "", dispatch: Promise.resolve(), pending: new Map(), interactions: new Map(), active: undefined, quarantined: false, abortRequested: false, abortPromise: undefined, closed: false };
    const opaqueId = `pi_${context.gatewaySessionId}`;
    this.sessions.set(opaqueId, session);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.read(session, chunk));
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => this.closeWithError(session, engineError("UNAVAILABLE", "Pi process failed", error)));
    child.once("exit", (code, signal) => { if (!this.stopping && !session.closed) this.closeWithError(session, engineError("UNAVAILABLE", `Pi process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`)); });
    try {
      const response = await this.sendCommand(session, { type: "new_session", id: `new_${context.gatewaySessionId}` });
      if (response.success !== true) throw new Error("Pi did not accept new_session");
      return { opaqueId };
    } catch (error) {
      await this.disposeSession(opaqueId, session);
      throw toAdapterError(error, "Pi session creation failed");
    }
  }

  async run(ref: EngineSessionRef, input: RunInput, sink: EngineEventSink, signal: AbortSignal): Promise<RunResult> {
    const session = this.requireSession(ref);
    if (session.quarantined) {
      const error = engineError("UNAVAILABLE", "Pi session is still settling after an abort");
      try { await sink({ type: "run.failed", error }); } catch { /* Coordinator still receives the result. */ }
      return { state: "failed", error };
    }
    if (session.active) return { state: "failed", error: engineError("INTERNAL", "Pi session already has an active run") };
    return new Promise<RunResult>((resolve) => {
      const active: ActiveRun = { input, sink, signal, mapping: createPiMappingState(), resolve, finished: false, abortListener: () => { void this.cancelRun(session, active); } };
      session.active = active;
      signal.addEventListener("abort", active.abortListener, { once: true });
      void this.sendPrompt(session, active);
    });
  }

  async replyQuestion(ref: EngineSessionRef, interaction: EngineInteractionRef, answers: string[][]): Promise<void> {
    const session = this.requireSession(ref);
    const request = session.interactions.get(interaction.opaqueId);
    if (!request || request.kind !== "question") throw new Error("Unknown Pi question");
    const value = answers[0]?.[0] ?? "";
    await this.sendExtensionResponse(session, interaction.opaqueId, value);
  }

  async replyPermission(ref: EngineSessionRef, interaction: EngineInteractionRef, decision: PermissionDecision): Promise<void> {
    const session = this.requireSession(ref);
    const request = session.interactions.get(interaction.opaqueId);
    if (!request || request.kind !== "permission") throw new Error("Unknown Pi permission");
    const value = request.request.method === "select"
      ? decision.reply === "always" ? "Always" : decision.reply === "once" ? "Once" : "Reject"
      : decision.reply !== "reject";
    await this.sendExtensionResponse(session, interaction.opaqueId, value);
  }

  async abort(ref: EngineSessionRef): Promise<void> {
    const session = this.requireSession(ref);
    if (!session.active || session.active.mapping.settled) return;
    session.quarantined = true;
    const active = session.active;
    try { await this.sendAbort(session); } finally { await this.finish(session, active, { state: "aborted" }); }
  }

  async deleteSession(ref: EngineSessionRef): Promise<void> {
    const opaqueId = ref.opaqueId;
    const session = this.sessions.get(opaqueId);
    if (!session) return;
    await this.disposeSession(opaqueId, session);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const [id, session] of [...this.sessions]) await this.disposeSession(id, session);
    await this.removeGeneratedConfig();
    this.started = false;
    this.config = undefined;
  }

  private spawnProcess(context: SessionContext, config: EngineConfig): ChildProcess {
    const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", this.bridgePath, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--provider", config.model.providerId, "--model", config.model.modelId];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.model.baseUrl) env.PI_MODEL_BASE_URL = config.model.baseUrl;
    if (this.generatedConfigDir) env.PI_CODING_AGENT_DIR = this.generatedConfigDir;
    return (this.options.spawnImpl ?? spawn)(this.commandPath, [...this.commandArgs, ...args], { cwd: context.directory, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  }

  private async preparePiConfig(model: EngineConfig["model"]): Promise<void> {
    if (process.env.PI_CODING_AGENT_DIR || this.generatedConfigDir || !model.baseUrl) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-gateway-pi-"));
    const provider = buildPiModelsConfig(model).providers[model.providerId];
    try {
      await writeFile(path.join(dir, "models.json"), `${JSON.stringify({ providers: { [model.providerId]: provider } }, null, 2)}\n`, "utf8");
      this.generatedConfigDir = dir;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async removeGeneratedConfig(): Promise<void> {
    const dir = this.generatedConfigDir;
    this.generatedConfigDir = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  private read(session: PiSession, chunk: string): void {
    session.buffer += chunk;
    while (true) {
      const newline = session.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = session.buffer.slice(0, newline);
      session.buffer = session.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch (error) { this.closeWithError(session, engineError("UPSTREAM_ERROR", "Pi emitted invalid JSONL", error)); continue; }
      session.dispatch = session.dispatch.then(() => this.handle(session, value)).catch((error) => this.closeWithError(session, toAdapterError(error, "Pi RPC event handling failed")));
    }
  }

  private async handle(session: PiSession, value: unknown): Promise<void> {
    if (!isRecord(value) || session.closed) return;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "response" && typeof value.id === "string") {
      const pending = session.pending.get(value.id);
      if (!pending) return;
      session.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.success === false) pending.reject(new Error(typeof value.error === "string" ? value.error : "Pi RPC command failed"));
      else pending.resolve(value);
      return;
    }
    if (type === "extension_ui_request") {
      await this.handleUiRequest(session, value);
      return;
    }
    if (type === "agent_settled") { session.quarantined = false; session.abortRequested = false; session.abortPromise = undefined; }
    const active = session.active;
    if (!active) return;
    for (const event of mapPiEvent(value, active.mapping)) await this.emit(session, active, event);
  }

  private async handleUiRequest(session: PiSession, value: Record<string, unknown>): Promise<void> {
    const id = typeof value.id === "string" ? value.id : undefined;
    const method = typeof value.method === "string" ? value.method : undefined;
    if (!id || !method) return;
    if (!session.active) { await this.sendExtensionResponse(session, id, method === "confirm" ? false : ""); return; }
    if (method === "confirm" || (method === "select" && typeof value.title === "string" && value.title.startsWith("Permission:"))) session.interactions.set(id, { kind: "permission", request: value });
    else if (method === "select" || method === "input" || method === "editor") session.interactions.set(id, { kind: "question", request: value });
    else return;
    for (const event of mapPiEvent(value, session.active.mapping)) await this.emit(session, session.active, event);
  }

  private async sendPrompt(session: PiSession, active: ActiveRun): Promise<void> {
    if (active.signal.aborted) return this.finish(session, active, { state: "aborted" });
    try { await this.sendCommand(session, { type: "prompt", id: active.input.gatewayRunId, message: active.input.text }); }
    catch (error) { if (!active.signal.aborted) await this.emit(session, active, { type: "run.failed", error: toAdapterError(error, "Pi prompt failed") }); }
  }

  private async sendAbort(session: PiSession): Promise<void> {
    if (session.closed) return;
    if (session.active) markPiAborted(session.active.mapping);
    if (session.abortPromise) return session.abortPromise;
    if (session.abortRequested) return;
    session.abortRequested = true;
    session.quarantined = true;
    const request = this.sendCommand(session, { type: "abort", id: `abort_${randomUUID()}` }, this.options.abortGraceMs ?? this.options.controlTimeoutMs)
      .then(() => undefined)
      .catch(() => { /* Abort is best effort; Coordinator owns the accepted terminal state. */ });
    session.abortPromise = request;
    return request;
  }

  private async sendExtensionResponse(session: PiSession, id: string, value: string | boolean): Promise<void> {
    if (session.closed) throw engineError("UNAVAILABLE", "Pi session is closed");
    // extension_ui_response is a JSONL notification, not a command: Pi does not
    // acknowledge it with a response envelope (see the RPC probe fixture).
    const payload = typeof value === "boolean" ? { type: "extension_ui_response", id, confirmed: value } : { type: "extension_ui_response", id, value };
    const stdin = session.child.stdin;
    if (!stdin) throw engineError("UNAVAILABLE", "Pi RPC stdin is unavailable");
    try { stdin.write(`${JSON.stringify(payload)}\n`); }
    catch (error) { throw toAdapterError(error, "Pi interaction reply failed"); }
    session.interactions.delete(id);
  }

  private sendCommand(session: PiSession, value: Record<string, unknown>, timeoutMs = this.options.controlTimeoutMs ?? this.config?.healthTimeoutMs ?? 5_000): Promise<Record<string, unknown>> {
    const id = typeof value.id === "string" ? value.id : undefined;
    if (!id || !session.child.stdin || session.closed) return Promise.reject(new Error("Pi RPC session is unavailable"));
    const stdin = session.child.stdin;
    if (!stdin) return Promise.reject(new Error("Pi RPC stdin is unavailable"));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(engineError("TIMEOUT", "Pi RPC command timed out")); }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      try { stdin.write(`${JSON.stringify(value)}\n`); }
      catch (error) { clearTimeout(timer); session.pending.delete(id); reject(error); }
    });
  }

  private async emit(session: PiSession, active: ActiveRun, event: EngineEvent): Promise<void> {
    if (active.finished) return;
    try { await active.sink(event); }
    catch (error) { await this.finish(session, active, { state: "failed", error: engineError("INTERNAL", "Gateway event sink failed", error) }); return; }
    if (event.type === "run.settled") await this.finish(session, active, { state: "completed" });
    else if (event.type === "run.failed") await this.finish(session, active, { state: "failed", error: event.error });
    else if (event.type === "run.aborted") await this.finish(session, active, { state: "aborted" });
  }

  private async cancelRun(session: PiSession, active: ActiveRun): Promise<void> {
    if (active.finished || active.mapping.settled) return;
    await this.sendAbort(session);
    await this.finish(session, active, { state: "aborted" });
  }

  private async finish(session: PiSession, active: ActiveRun, result: RunResult): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    active.signal.removeEventListener("abort", active.abortListener);
    if (session.active === active) session.active = undefined;
    active.resolve(result);
  }

  private closeWithError(session: PiSession, error: EngineError): void {
    if (session.closed) return;
    session.closed = true;
    for (const [id, pending] of session.pending) { clearTimeout(pending.timer); pending.reject(error); session.pending.delete(id); }
    const active = session.active;
    if (active) void this.emit(session, active, { type: "run.failed", error });
  }

  private async disposeSession(id: string, session: PiSession): Promise<void> {
    this.sessions.delete(id);
    session.closed = true;
    if (session.active) await this.finish(session, session.active, { state: "aborted" });
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi session disposed")); }
    session.pending.clear();
    if (session.child.exitCode === null) await terminateProcessTree(session.child);
  }

  private requireSession(ref: EngineSessionRef): PiSession { const session = this.sessions.get(ref.opaqueId); if (!session) throw new Error("Unknown Pi session"); return session; }
}

export function buildPiModelsConfig(model: EngineConfig["model"]): { providers: Record<string, { baseUrl: string; api: "openai-completions"; apiKey?: string; authHeader?: boolean; models: Array<{ id: string; name: string }> }> } {
  const credentialEnv = model.credentialRef.startsWith("env:") ? model.credentialRef.slice(4) : undefined;
  return { providers: { [model.providerId]: { baseUrl: model.baseUrl ?? "", api: "openai-completions", ...(credentialEnv ? { apiKey: `$${credentialEnv}`, authHeader: true } : {}), models: [{ id: model.modelId, name: model.modelId }] } } };
}

function normalizeCommand(command: string): PiCommand {
  const value = command.trim();
  if (/\.(cmd|bat)$/i.test(value)) throw new Error("PI_COMMAND must reference a native executable or JavaScript file; .cmd/.bat shims are not supported");
  if (value.toLowerCase() === "pi") {
    const cliPath = resolveBundledPiCli();
    return { executable: process.execPath, args: [cliPath] };
  }
  if (/\.js$/i.test(value)) return { executable: process.execPath, args: [value] };
  return { executable: value, args: [] };
}

function resolveBridgePath(): string {
  const compiled = fileURLToPath(new URL("./gateway-bridge.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL("./gateway-bridge.ts", import.meta.url));
  return source;
}

function commandVersion(command: PiCommand): string | undefined {
  const result = spawnSync(command.executable, [...command.args, "--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.status !== 0) return undefined;
  const value = `${result.stdout ?? ""}`.trim().split(/\s+/)[0] ?? "";
  return /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

function resolveBundledPiCli(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cliPath = path.resolve(path.dirname(packageEntry), "bundle", "cli.js");
  if (!existsSync(cliPath)) throw new Error(`Bundled Pi CLI was not found: ${cliPath}`);
  return cliPath;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) await new Promise<void>((resolve) => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); killer.once("close", () => resolve()); killer.once("error", () => resolve()); });
  else child.kill("SIGTERM");
}

function engineError(code: EngineError["code"], message: string, cause?: unknown): EngineError { return { code, message, retryable: code !== "INTERNAL", ...(cause === undefined ? {} : { cause }) }; }
function toAdapterError(error: unknown, fallback: string): EngineError { if (isEngineError(error)) return error; return engineError("UPSTREAM_ERROR", error instanceof Error ? error.message : fallback, error); }
function isEngineError(value: unknown): value is EngineError { return Boolean(value && typeof value === "object" && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
