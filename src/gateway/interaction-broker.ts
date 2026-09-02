import { randomUUID } from "node:crypto";
import { fromEngineError, GatewayError } from "../model/errors.js";
import type { EngineError, EngineEvent, GatewayInteraction, GatewaySession, HarnessAdapter, PermissionDecision } from "../model/types.js";

export class InteractionBroker {
  private readonly interactions = new Map<string, GatewayInteraction>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<void> }>();
  constructor(private readonly adapter: HarnessAdapter) {}

  create(session: GatewaySession, runId: string, event: Extract<EngineEvent,{type:"question.requested"|"permission.requested"}>): GatewayInteraction {
    const interaction: GatewayInteraction = { id: `${event.type.startsWith("question") ? "req" : "perm"}_${randomUUID()}`, sessionId: session.id, runId, kind: event.type.startsWith("question") ? "question" : "permission", engineRef: event.interactionRef, state: "pending", payload: event.type === "question.requested" ? event.questions : { permission: event.permission, patterns: event.patterns }, createdAt: new Date().toISOString() };
    this.interactions.set(interaction.id, interaction); session.pendingInteractionIds.push(interaction.id); return interaction;
  }

  questions(): unknown[] { return [...this.interactions.values()].filter((x)=>x.kind==="question"&&x.state==="pending").map((x)=>({ id:x.id, sessionID:x.sessionId, questions:x.payload, created_at:x.createdAt })); }
  permissions(): unknown[] { return [...this.interactions.values()].filter((x)=>x.kind==="permission"&&x.state==="pending").map((x)=>({ id:x.id, sessionID:x.sessionId, ...(x.payload as object), created_at:x.createdAt })); }

  async replyQuestion(id: string, answers: string[][], session: GatewaySession): Promise<void> {
    const interaction = this.requireKind(id, "question"); const fingerprint=JSON.stringify(answers);
    const existing=this.inFlight.get(id); if(existing){if(existing.fingerprint!==fingerprint)throw new GatewayError(409,"INTERACTION_RESOLVED","Interaction already has a different reply");await existing.promise;return;}
    if(interaction.state!=="pending"){if(interaction.responseFingerprint===fingerprint)return;throw new GatewayError(409,"INTERACTION_RESOLVED","Interaction already resolved");}
    const promise=this.sendQuestion(interaction,session,answers,fingerprint);this.inFlight.set(id,{fingerprint,promise});
    try { await promise; } finally { if(this.inFlight.get(id)?.promise===promise)this.inFlight.delete(id); }
  }
  async replyPermission(id: string, decision: PermissionDecision, session: GatewaySession): Promise<void> {
    const interaction = this.requireKind(id, "permission"); const fingerprint=JSON.stringify(decision);
    const existing=this.inFlight.get(id); if(existing){if(existing.fingerprint!==fingerprint)throw new GatewayError(409,"INTERACTION_RESOLVED","Interaction already has a different reply");await existing.promise;return;}
    if(interaction.state!=="pending"){if(interaction.responseFingerprint===fingerprint)return;throw new GatewayError(409,"INTERACTION_RESOLVED","Interaction already resolved");}
    const promise=this.sendPermission(interaction,session,decision,fingerprint);this.inFlight.set(id,{fingerprint,promise});
    try { await promise; } finally { if(this.inFlight.get(id)?.promise===promise)this.inFlight.delete(id); }
  }
  get(id: string): GatewayInteraction { const value=this.interactions.get(id); if(!value) throw new GatewayError(404,"NOT_FOUND","Interaction not found"); return value; }
  expireRun(runId: string): void { for(const x of this.interactions.values()) if(x.runId===runId&&x.state==="pending") x.state="expired"; }
  removeSession(sessionId: string): void { for(const [id,x] of this.interactions) if(x.sessionId===sessionId) this.interactions.delete(id); }

  private requireKind(id: string, kind: "question"|"permission"): GatewayInteraction { const x=this.get(id); if(x.kind!==kind) throw new GatewayError(404,"NOT_FOUND","Interaction not found"); return x; }
  private async sendQuestion(interaction: GatewayInteraction, session: GatewaySession, answers: string[][], fingerprint: string): Promise<void> {
    try { await this.adapter.replyQuestion(session.engineSession, interaction.engineRef, answers); interaction.responseFingerprint=fingerprint;interaction.state="answered"; }
    catch(error){ throw this.translateAdapterError(error); }
  }
  private async sendPermission(interaction: GatewayInteraction, session: GatewaySession, decision: PermissionDecision, fingerprint: string): Promise<void> {
    try { await this.adapter.replyPermission(session.engineSession, interaction.engineRef, decision); interaction.responseFingerprint=fingerprint;interaction.state=decision.reply==="reject"?"rejected":"answered"; }
    catch(error){ throw this.translateAdapterError(error); }
  }
  private translateAdapterError(error: unknown): unknown { return isEngineError(error)?fromEngineError(error):error; }
}

function isEngineError(error: unknown): error is EngineError {
  return Boolean(error&&typeof error==="object"&&["INVALID_REQUEST","UNAVAILABLE","UPSTREAM_ERROR","TIMEOUT","INTERNAL"].includes(String((error as {code?:unknown}).code))&&typeof (error as {message?:unknown}).message==="string");
}
