import { randomUUID } from "node:crypto";
import { GatewayError } from "../model/errors.js";
import type { EngineSessionRef, GatewaySession } from "../model/types.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, GatewaySession>();
  constructor(private readonly maxSessions = 32) {}

  newId(): string { return `ses_${randomUUID()}`; }
  assertCapacity(): void { if (this.sessions.size >= this.maxSessions) throw new GatewayError(503, "CAPACITY_EXCEEDED", "Session capacity exceeded"); }
  register(title: string, directory: string, engine: string, engineSession: EngineSessionRef, id=this.newId()): GatewaySession {
    if (this.sessions.size >= this.maxSessions) throw new GatewayError(503, "CAPACITY_EXCEEDED", "Session capacity exceeded");
    const session: GatewaySession = { id, title, createdAt: new Date().toISOString(), status: "idle", directory, engine, engineSession, messages: [], pendingInteractionIds: [] };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): GatewaySession {
    const session = this.sessions.get(id);
    if (!session || session.deleting) throw new GatewayError(404, "NOT_FOUND", "Session not found");
    return session;
  }
  maybeGet(id: string): GatewaySession | undefined { const session = this.sessions.get(id); return session?.deleting ? undefined : session; }
  all(): GatewaySession[] { return [...this.sessions.values()].filter((session) => !session.deleting); }
  markDeleting(id: string): GatewaySession { const session = this.get(id); session.deleting = true; return session; }
  remove(id: string): void { this.sessions.delete(id); }
}
