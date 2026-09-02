import { randomUUID } from "node:crypto";
import type { EngineEvent, GatewayEvent, GatewayMessage, GatewayMessagePart, GatewaySession } from "../model/types.js";

interface Projection { assistants: Map<string, GatewayMessage>; calls: Map<string, { id: string; message: GatewayMessage; part: Extract<GatewayMessagePart, {type:"tool"}>; completed: boolean; output?: unknown }>; seen: Set<string>; last?: GatewayMessage }

export class MessageProjector {
  private readonly runs = new Map<string, Projection>();
  constructor(private readonly emit: (event: GatewayEvent) => void) {}

  addUser(session: GatewaySession, runId: string, text: string): void {
    session.messages.push({ id: `msg_${randomUUID()}`, sessionId: session.id, role: "user", content: text, createdAt: new Date().toISOString() });
    this.runs.set(runId, { assistants: new Map(), calls: new Map(), seen: new Set() });
  }

  apply(session: GatewaySession, runId: string, event: EngineEvent): void {
    const p = this.runs.get(runId);
    if (!p) return;
    if (event.type === "text.delta") {
      const message = this.assistant(session, p, event.messageRef || "default");
      const key = JSON.stringify(event); if (p.seen.has(key)) return; p.seen.add(key);
      let part = message.parts!.find((x): x is Extract<GatewayMessagePart,{type:"text"}> => x.type === "text");
      if (!part) { part = { type: "text", content: "" }; message.parts!.push(part); }
      part.content += event.delta; message.content += event.delta;
      this.updated(session.id, message.id, { ...part });
    } else if (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed") {
      let call = p.calls.get(event.callRef);
      if (!call) {
        const message = p.last ?? this.assistant(session, p, "default");
        const id = `call_${randomUUID()}`;
        const part: Extract<GatewayMessagePart,{type:"tool"}> = { type: "tool", callId: id, tool: event.type === "tool.started" ? event.name : "unknown", state: { status: "running" } };
        message.parts!.push(part); message.toolCalls!.push({ id, name: part.tool, arguments: event.type === "tool.started" ? event.args ?? {} : {} });
        call = { id, message, part, completed: false }; p.calls.set(event.callRef, call);
      }
      const key = JSON.stringify(event); if (p.seen.has(key)) return; p.seen.add(key);
      if (call.completed) return;
      if (event.type === "tool.started") { call.part.tool = event.name; if(event.title !== undefined) call.part.state.title = event.title; const tc=call.message.toolCalls!.find(x=>x.id===call!.id)!; tc.name=event.name; tc.arguments=event.args ?? {}; }
      if (event.type === "tool.updated") { if (event.title !== undefined) call.part.state.title = event.title; if (event.args !== undefined) call.message.toolCalls!.find(x=>x.id===call!.id)!.arguments = event.args; call.output = event.output; }
      if (event.type === "tool.completed") {
        call.part.state.status = "completed"; if (event.title !== undefined) call.part.state.title = event.title; call.output = event.output; call.completed = true;
        session.messages.push({ id: `msg_${randomUUID()}`, sessionId: session.id, role: "tool", content: this.stringify(event.output), toolCallId: call.id, toolName: call.part.tool, createdAt: new Date().toISOString() });
      }
      this.updated(session.id, call.message.id, structuredClone(call.part));
    } else if (event.type === "step.finished") {
      const message = p.last ?? this.assistant(session, p, "default");
      const key = JSON.stringify({ type:event.type, finish:event.finish, count:message.parts!.filter(x=>x.type==="step-finish").length });
      if (!p.seen.has(key)) { p.seen.add(key); message.parts!.push({ type: "step-finish" }); this.updated(session.id, message.id, { type: "step-finish" }); }
      message.info = { role: "assistant", finish: event.finish };
    }
  }

  settle(session: GatewaySession, runId: string): void {
    const p = this.runs.get(runId); if (!p) return;
    const message = p.last ?? this.assistant(session, p, "default");
    if (!message.parts!.some((x) => x.type === "step-finish")) { message.parts!.push({ type: "step-finish" }); this.updated(session.id, message.id, { type: "step-finish" }); }
    message.info = { role: "assistant", finish: "stop" };
  }
  finish(runId: string): void { this.runs.delete(runId); }

  private assistant(session: GatewaySession, p: Projection, ref: string): GatewayMessage {
    let message = p.assistants.get(ref);
    if (!message) { message = { id: `msg_${randomUUID()}`, sessionId: session.id, role: "assistant", content: "", createdAt: new Date().toISOString(), toolCalls: [], parts: [] }; p.assistants.set(ref, message); p.last = message; session.messages.push(message); }
    return message;
  }
  private updated(sessionID: string, messageID: string, part: GatewayMessagePart): void { this.emit({ type: "message.part.updated", properties: { sessionID, messageID, part } }); }
  private stringify(value: unknown): string { if (typeof value === "string") return value; if (value === undefined) return ""; try { return JSON.stringify(value); } catch { return "[unserializable output]"; } }
}
