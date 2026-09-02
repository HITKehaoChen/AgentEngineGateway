import type { EngineError, EngineEvent, Question } from "../../model/types.js";

export interface PiMappingState {
  started: boolean;
  settled: boolean;
  aborted: boolean;
  failed: boolean;
  assistantMessageRef: string;
  assistantMessageIndex: number;
  textParts: Map<string, string>;
  toolCalls: Map<string, { name: string; started: boolean; completed: boolean; argsText: string }>;
  seen: Set<string>;
}

export function createPiMappingState(): PiMappingState {
  return { started: false, settled: false, aborted: false, failed: false, assistantMessageRef: "assistant-0", assistantMessageIndex: 0, textParts: new Map(), toolCalls: new Map(), seen: new Set() };
}

/** Marks Abort as authoritative before Pi's late settlement notification arrives. */
export function markPiAborted(state: PiMappingState): void { state.aborted = true; }

/** Converts Pi RPC notifications into the engine-neutral event vocabulary. */
export function mapPiEvent(raw: unknown, state: PiMappingState): EngineEvent[] {
  if (!isRecord(raw)) return [];
  const type = string(raw.type);
  if (!type) return [];
  const eventId = string(raw.id);
  if (eventId && !type.startsWith("extension_ui_")) {
    const key = `event:${eventId}`;
    if (state.seen.has(key)) return [];
    state.seen.add(key);
  }

  if (type === "agent_start") {
    if (state.started) return [];
    state.started = true;
    state.settled = false;
    state.aborted = false;
    state.failed = false;
    return [{ type: "run.started" }];
  }
  if (type === "agent_settled") {
    state.settled = true;
    return state.started && !state.aborted && !state.failed ? [{ type: "run.settled" }] : [];
  }
  if (type === "agent_end") return [];
  if (type === "turn_end") return state.started && !state.aborted && !state.failed ? [{ type: "step.finished", finish: turnFinish(raw.message) }] : [];
  if (type === "error" || type === "fatal_error") {
    state.failed = true;
    return [{ type: "run.failed", error: errorFrom(raw.error ?? raw.message, "Pi RPC reported an error") }];
  }
  if (type === "extension_ui_request") return mapInteraction(raw);
  if (type === "tool_execution_start") return mapToolStart(raw, state);
  if (type === "tool_execution_update") return mapToolUpdate(raw, state);
  if (type === "tool_execution_end") return mapToolEnd(raw, state);

  if (type === "message_start") {
    const message = isRecord(raw.message) ? raw.message : {};
    if (message.role === "assistant") {
      const explicit = string(message.id) ?? string(message.messageId);
      state.assistantMessageRef = explicit ?? `assistant-${state.assistantMessageIndex++}`;
    }
    return [];
  }
  if (type !== "message_update") return [];
  const update = isRecord(raw.assistantMessageEvent) ? raw.assistantMessageEvent : {};
  const updateType = string(update.type);
  if (updateType === "text_delta") {
    if (!state.started || typeof update.delta !== "string") return [];
    const contentIndex = numberString(update.contentIndex);
    const key = `${state.assistantMessageRef}:${contentIndex}`;
    state.textParts.set(key, (state.textParts.get(key) ?? "") + update.delta);
    return [{ type: "text.delta", messageRef: state.assistantMessageRef, delta: update.delta }];
  }
  if (updateType === "text_end") return [];
  if (updateType === "toolcall_start") {
    const callId = string(update.id);
    const name = string(update.toolName) ?? "tool";
    if (!callId) return [];
    const current = state.toolCalls.get(callId) ?? { name, started: false, completed: false, argsText: "" };
    current.name = name;
    state.toolCalls.set(callId, current);
    if (current.started) return [];
    current.started = true;
    return [{ type: "tool.started", callRef: callId, name }];
  }
  if (updateType === "toolcall_delta") {
    const callId = string(update.id);
    if (!callId || typeof update.delta !== "string") return [];
    const current = state.toolCalls.get(callId) ?? { name: "tool", started: false, completed: false, argsText: "" };
    current.argsText += update.delta;
    state.toolCalls.set(callId, current);
    if (!current.started) { current.started = true; return [{ type: "tool.started", callRef: callId, name: current.name }]; }
    const args = parseJson(current.argsText);
    return args === undefined ? [] : [{ type: "tool.updated", callRef: callId, args }];
  }
  if (updateType === "toolcall_end") {
    const call = isRecord(update.toolCall) ? update.toolCall : {};
    const callId = string(call.id) ?? string(update.id);
    const name = string(call.name) ?? "tool";
    if (!callId) return [];
    const current = state.toolCalls.get(callId) ?? { name, started: false, completed: false, argsText: "" };
    current.name = name;
    state.toolCalls.set(callId, current);
    if (current.completed) return [];
    const result: EngineEvent[] = [];
    if (!current.started) { current.started = true; result.push({ type: "tool.started", callRef: callId, name }); }
    if (call.arguments !== undefined) result.push({ type: "tool.updated", callRef: callId, args: call.arguments });
    return result;
  }
  return [];
}

function mapToolStart(raw: Record<string, unknown>, state: PiMappingState): EngineEvent[] {
  const callRef = string(raw.toolCallId) ?? string(raw.id);
  const name = string(raw.toolName) ?? string(raw.name);
  if (!callRef || !name) return [];
  const current = state.toolCalls.get(callRef);
  if (current?.started) return [];
  state.toolCalls.set(callRef, { name, started: true, completed: false, argsText: "" });
  return [{ type: "tool.started", callRef, name, ...(raw.args === undefined ? {} : { args: raw.args }) }];
}

function mapToolUpdate(raw: Record<string, unknown>, state: PiMappingState): EngineEvent[] {
  const callRef = string(raw.toolCallId) ?? string(raw.id);
  if (!callRef) return [];
  const current = state.toolCalls.get(callRef) ?? { name: string(raw.toolName) ?? "tool", started: true, completed: false, argsText: "" };
  state.toolCalls.set(callRef, current);
  const output = raw.partialResult ?? raw.result ?? raw.output;
  const title = string(raw.toolName);
  return [{ type: "tool.updated", callRef, ...(title === undefined ? {} : { title }), ...(output === undefined ? {} : { output }), ...(raw.args === undefined ? {} : { args: raw.args }) }];
}

function mapToolEnd(raw: Record<string, unknown>, state: PiMappingState): EngineEvent[] {
  const callRef = string(raw.toolCallId) ?? string(raw.id);
  if (!callRef) return [];
  const current = state.toolCalls.get(callRef);
  if (current?.completed) return [];
  state.toolCalls.set(callRef, { ...(current ?? { name: string(raw.toolName) ?? "tool", started: true, argsText: "" }), completed: true });
  const output = raw.result ?? raw.output;
  const isError = raw.isError === true || raw.error !== undefined;
  const title = string(raw.toolName);
  return [{ type: "tool.completed", callRef, ...(title === undefined ? {} : { title }), ...(output === undefined ? {} : { output }), isError }];
}

function mapInteraction(raw: Record<string, unknown>): EngineEvent[] {
  const id = string(raw.id);
  const method = string(raw.method);
  if (!id) return [];
  if (method === "confirm") return [{ type: "permission.requested", interactionRef: { opaqueId: id }, permission: string(raw.title) ?? "confirmation", patterns: [] }];
  if (method === "select") {
    const options = Array.isArray(raw.options) ? raw.options.filter((x): x is string => typeof x === "string") : [];
    const title = string(raw.title) ?? "Choose";
    if (title.startsWith("Permission:")) {
      const parsed = parsePermissionTitle(title);
      return [{ type: "permission.requested", interactionRef: { opaqueId: id }, permission: parsed.permission, patterns: parsed.patterns }];
    }
    return [{ type: "question.requested", interactionRef: { opaqueId: id }, questions: [{ question: title, options: options.map((label) => ({ label })) }] }];
  }
  if (method === "input" || method === "editor") return [{ type: "question.requested", interactionRef: { opaqueId: id }, questions: [{ question: string(raw.title) ?? "Input required", options: [] }] }];
  return [];
}

function parsePermissionTitle(title: string): { permission: string; patterns: string[] } {
  const value = title.slice("Permission:".length).trim();
  const match = /^(.*?)\s+\[patterns:\s*(\[[\s\S]*\])\]\s*$/.exec(value);
  if (!match) return { permission: value, patterns: [] };
  const permission = match[1]?.trim() || "permission";
  const encoded = match[2] ?? "[]";
  try {
    const patterns = JSON.parse(encoded) as unknown;
    return { permission, patterns: Array.isArray(patterns) ? patterns.filter((item): item is string => typeof item === "string") : [] };
  } catch { return { permission, patterns: [] }; }
}

function turnFinish(value: unknown): "tool-calls" | "stop" {
  const message = isRecord(value) ? value : {};
  const reason = string(message.stopReason) ?? string(message.rawStopReason);
  return reason === "toolUse" || reason === "tool_calls" || reason === "tool-calls" ? "tool-calls" : "stop";
}

function errorFrom(value: unknown, fallback: string): EngineError {
  const valueRecord = isRecord(value) ? value : {};
  return { code: "UPSTREAM_ERROR", message: string(valueRecord.message) ?? (typeof value === "string" ? value : fallback), retryable: true };
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function numberString(value: unknown): string { return typeof value === "number" || typeof value === "string" ? String(value) : "0"; }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
