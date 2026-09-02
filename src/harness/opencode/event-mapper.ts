import type { EngineEvent, Question } from "../../model/types.js";

/** The intentionally small subset of OpenCode's wire model used by the adapter. */
export interface OpenCodeEvent {
  id?: unknown;
  type?: unknown;
  properties?: unknown;
}

interface MappingState {
  started: boolean;
  textParts: Map<string, string>;
  partKinds: Map<string, string>;
  toolParts: Map<string, { name: string; started: boolean; completed: boolean }>;
  seen: Set<string>;
}

export function createOpenCodeMappingState(): MappingState {
  return { started: false, textParts: new Map(), partKinds: new Map(), toolParts: new Map(), seen: new Set() };
}

export function mapOpenCodeEvent(raw: unknown, state: MappingState): EngineEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const event = raw as OpenCodeEvent;
  const type = typeof event.type === "string" ? event.type : "";
  const properties = isRecord(event.properties) ? event.properties : {};
  const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
  if (!sessionId && type !== "server.connected") return [];
  if (typeof event.id === "string") {
    const eventKey = `event:${event.id}`;
    if (state.seen.has(eventKey)) return [];
    state.seen.add(eventKey);
  }

  if (type === "session.status") {
    const status = isRecord(properties.status) ? properties.status.type : undefined;
    if (status === "busy") {
      if (state.started) return [];
      state.started = true;
      return [{ type: "run.started" }];
    }
    if (status === "idle" && state.started) return [{ type: "run.settled" }];
    if (status === "error") return [failedFrom(properties.error, "OpenCode session failed")];
    return [];
  }
  if (type === "session.idle") return state.started ? [{ type: "run.settled" }] : [];
  if (type === "session.error") return [failedFrom(properties.error, "OpenCode session failed")];
  if (!state.started) return [];

  if (type === "question.asked") {
    const id = typeof properties.id === "string" ? properties.id : undefined;
    const questions = Array.isArray(properties.questions) ? properties.questions.filter(isQuestion) : [];
    return id && questions.length ? [{ type: "question.requested", interactionRef: { opaqueId: id }, questions }] : [];
  }
  if (type === "permission.asked") {
    const id = typeof properties.id === "string" ? properties.id : undefined;
    const permission = typeof properties.permission === "string" ? properties.permission : undefined;
    const patterns = Array.isArray(properties.patterns) ? properties.patterns.filter((x): x is string => typeof x === "string") : [];
    return id && permission ? [{ type: "permission.requested", interactionRef: { opaqueId: id }, permission, patterns }] : [];
  }
  if (type === "message.part.delta") {
    const messageId = typeof properties.messageID === "string" ? properties.messageID : undefined;
    const partId = typeof properties.partID === "string" ? properties.partID : messageId;
    const delta = typeof properties.delta === "string" ? properties.delta : undefined;
    if (!messageId || !partId || properties.field !== "text" || delta === undefined) return [];
    if (state.partKinds.get(partId) !== "text") return [];
    state.textParts.set(partId, (state.textParts.get(partId) ?? "") + delta);
    return [{ type: "text.delta", messageRef: messageId, delta }];
  }
  if (type === "message.part.updated") return mapPartUpdated(properties, state);
  return [];
}

function mapPartUpdated(properties: Record<string, unknown>, state: MappingState): EngineEvent[] {
  const part = isRecord(properties.part) ? properties.part : undefined;
  if (!part) return [];
  const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
  const partId = typeof part.id === "string" ? part.id : messageId;
  if (partId && typeof part.type === "string") state.partKinds.set(partId, part.type);
  const text = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : undefined;
  if (part.type === "text" && messageId && partId && text !== undefined) {
    const previous = state.textParts.get(partId) ?? "";
    if (text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      state.textParts.set(partId, text);
      if (delta) return [{ type: "text.delta", messageRef: messageId, delta }];
    }
    return [];
  }
  if (part.type === "step-finish") {
    const reason = part.reason === "tool-calls" || part.reason === "stop" ? part.reason : undefined;
    if (!reason || !partId || state.seen.has(`step:${partId}`)) return [];
    state.seen.add(`step:${partId}`);
    return [{ type: "step.finished", finish: reason }];
  }
  if (part.type !== "tool") return [];
  const callId = typeof part.callID === "string" ? part.callID : undefined;
  const name = typeof part.tool === "string" ? part.tool : undefined;
  const toolState = isRecord(part.state) ? part.state : {};
  const status = typeof toolState.status === "string" ? toolState.status : "running";
  if (!callId || !name) return [];
  const title = typeof toolState.title === "string" ? toolState.title : typeof part.title === "string" ? part.title : undefined;
  const args = "input" in toolState ? toolState.input : undefined;
  const output = "output" in toolState ? toolState.output : isRecord(toolState.metadata) ? toolState.metadata.output : undefined;
  const isError = status === "error" || (isRecord(toolState.metadata) && typeof toolState.metadata.exit === "number" && toolState.metadata.exit !== 0);
  const current = state.toolParts.get(callId) ?? { name, started: false, completed: false };
  current.name = name;
  state.toolParts.set(callId, current);
  if (current.completed) return [];
  const result: EngineEvent[] = [];
  if (status === "completed" || status === "error") {
    if (!current.started) {
      current.started = true;
      result.push({ type: "tool.started", callRef: callId, name, ...(title === undefined ? {} : { title }), ...(args === undefined ? {} : { args }) });
    }
    current.completed = true;
    result.push({ type: "tool.completed", callRef: callId, ...(title === undefined ? {} : { title }), ...(output === undefined ? {} : { output }), isError });
  } else if (!current.started) {
    current.started = true;
    result.push({ type: "tool.started", callRef: callId, name, ...(title === undefined ? {} : { title }), ...(args === undefined ? {} : { args }) });
  } else if (title !== undefined || output !== undefined || args !== undefined) {
    result.push({ type: "tool.updated", callRef: callId, ...(title === undefined ? {} : { title }), ...(output === undefined ? {} : { output }), ...(args === undefined ? {} : { args }) });
  }
  return result;
}

function failedFrom(value: unknown, fallback: string): EngineEvent {
  const error = isRecord(value) ? value : {};
  const message = typeof error.message === "string" ? error.message : fallback;
  return { type: "run.failed", error: { code: "UPSTREAM_ERROR", message, retryable: true } };
}

function isQuestion(value: unknown): value is Question {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) return false;
  return value.options.every((option) => isRecord(option) && typeof option.label === "string" && (option.description === undefined || typeof option.description === "string"));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
