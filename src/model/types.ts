export type SessionStatus = "idle" | "busy";
export type RunState = "accepted" | "running" | "waiting_question" | "waiting_permission" | "completed" | "failed" | "aborted";

export interface EngineSessionRef { readonly opaqueId: string }
export interface EngineInteractionRef { readonly opaqueId: string }
export interface ResolvedModel { providerId: string; modelId: string; baseUrl?: string; credentialRef: string }
export interface Question { question: string; options: Array<{ label: string; description?: string }> }
export type PermissionDecision = { reply: "once" | "always" | "reject"; message?: string };
export interface EngineError {
  code: "INVALID_REQUEST" | "UNAVAILABLE" | "UPSTREAM_ERROR" | "TIMEOUT" | "INTERNAL";
  message: string;
  retryable: boolean;
  cause?: unknown;
}
export type RunResult = { state: "completed" } | { state: "failed"; error: EngineError } | { state: "aborted" };
export type EngineEvent =
  | { type: "run.started" }
  | { type: "text.delta"; messageRef: string; delta: string }
  | { type: "tool.started"; callRef: string; name: string; title?: string; args?: unknown }
  | { type: "tool.updated"; callRef: string; title?: string; output?: unknown }
  | { type: "tool.completed"; callRef: string; title?: string; output?: unknown; isError: boolean }
  | { type: "step.finished"; finish: "tool-calls" | "stop" }
  | { type: "question.requested"; interactionRef: EngineInteractionRef; questions: Question[] }
  | { type: "permission.requested"; interactionRef: EngineInteractionRef; permission: string; patterns: string[] }
  | { type: "run.settled" }
  | { type: "run.failed"; error: EngineError }
  | { type: "run.aborted" };

export function isEngineEvent(value: unknown): value is EngineEvent {
  if (!value || typeof value !== "object" || typeof (value as {type?:unknown}).type !== "string") return false;
  const event=value as Record<string,unknown>;const string=(key:string)=>typeof event[key]==="string";const optionalString=(key:string)=>event[key]===undefined||typeof event[key]==="string";
  const interaction=()=>Boolean(event.interactionRef&&typeof event.interactionRef==="object"&&typeof (event.interactionRef as {opaqueId?:unknown}).opaqueId==="string");
  switch(event.type){
    case "run.started":case "run.settled":case "run.aborted":return true;
    case "text.delta":return string("messageRef")&&string("delta");
    case "tool.started":return string("callRef")&&string("name")&&optionalString("title");
    case "tool.updated":return string("callRef")&&optionalString("title");
    case "tool.completed":return string("callRef")&&optionalString("title")&&typeof event.isError==="boolean";
    case "step.finished":return event.finish==="tool-calls"||event.finish==="stop";
    case "question.requested":return interaction()&&Array.isArray(event.questions)&&event.questions.every((question)=>Boolean(question&&typeof question==="object"&&typeof (question as {question?:unknown}).question==="string"&&Array.isArray((question as {options?:unknown}).options)&&((question as {options:unknown[]}).options).every((option)=>Boolean(option&&typeof option==="object"&&typeof (option as {label?:unknown}).label==="string"&&((option as {description?:unknown}).description===undefined||typeof (option as {description?:unknown}).description==="string")))));
    case "permission.requested":return interaction()&&string("permission")&&Array.isArray(event.patterns)&&event.patterns.every((pattern)=>typeof pattern==="string");
    case "run.failed":return Boolean(event.error&&typeof event.error==="object"&&["INVALID_REQUEST","UNAVAILABLE","UPSTREAM_ERROR","TIMEOUT","INTERNAL"].includes(String((event.error as {code?:unknown}).code))&&typeof (event.error as {message?:unknown}).message==="string"&&typeof (event.error as {retryable?:unknown}).retryable==="boolean");
    default:return false;
  }
}

export type EngineEventSink = (event: EngineEvent) => void | Promise<void>;
export interface HarnessAdapter {
  readonly name: string;
  start(config: EngineConfig): Promise<void>;
  health(): Promise<{ ok: boolean; version: string; message?: string }>;
  createSession(context: SessionContext): Promise<EngineSessionRef>;
  run(session: EngineSessionRef, input: RunInput, sink: EngineEventSink, signal: AbortSignal): Promise<RunResult>;
  replyQuestion(session: EngineSessionRef, interaction: EngineInteractionRef, answers: string[][]): Promise<void>;
  replyPermission(session: EngineSessionRef, interaction: EngineInteractionRef, decision: PermissionDecision): Promise<void>;
  abort(session: EngineSessionRef): Promise<void>;
  deleteSession(session: EngineSessionRef): Promise<void>;
  stop(): Promise<void>;
}
export interface EngineConfig { command: string; version: string; model: ResolvedModel; startupTimeoutMs: number; healthTimeoutMs: number }
export interface SessionContext { gatewaySessionId: string; title: string; directory: string }
export interface RunInput { gatewayRunId: string; text: string; model: ResolvedModel }

export interface GatewayToolCall { id: string; name: string; arguments: unknown }
export type GatewayMessagePart =
  | { type: "text"; content: string }
  | { type: "tool"; callId: string; tool: string; state: { status: "running" | "completed"; title?: string } }
  | { type: "step-finish" };
export interface GatewayMessage {
  id: string; sessionId: string; role: "user" | "assistant" | "tool"; content: string; createdAt: string;
  toolCalls?: GatewayToolCall[]; toolCallId?: string; toolName?: string;
  info?: { role: "assistant"; finish: "stop" | "tool-calls" }; parts?: GatewayMessagePart[];
}
export interface GatewaySession {
  id: string; title: string; createdAt: string; status: SessionStatus; directory: string; engine: string;
  engineSession: EngineSessionRef; activeRunId?: string; messages: GatewayMessage[]; pendingInteractionIds: string[];
  deleting?: boolean;
}
export interface GatewayRun { id: string; sessionId: string; state: RunState; startedAt: string; finishedAt?: string; error?: { code: string; message: string } }
export interface GatewayEvent { type: string; properties: Record<string, unknown> }
export interface GatewayInteraction {
  id: string; sessionId: string; runId: string; kind: "question" | "permission"; engineRef: EngineInteractionRef;
  state: "pending" | "answered" | "rejected" | "expired"; payload: unknown; createdAt: string; responseFingerprint?: string;
}
