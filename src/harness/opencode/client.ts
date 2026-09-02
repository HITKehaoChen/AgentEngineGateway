import { URL } from "node:url";

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`OpenCode HTTP ${status}`); }
}

export class OpenCodeClient {
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(method: string, route: string, options: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(route, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const init: RequestInit = { method };
    const controller = options.timeoutMs === undefined ? undefined : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forwardAbort: (() => void) | undefined;
    if (controller) {
      timer = setTimeout(() => controller.abort(), options.timeoutMs);
      if (options.signal) {
        forwardAbort = () => controller.abort();
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener("abort", forwardAbort, { once: true });
      }
      init.signal = controller.signal;
    } else if (options.signal) init.signal = options.signal;
    if (options.body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(options.body); }
    try {
      const response = await this.fetchImpl(url, init);
      const body = await response.text();
      if (!response.ok) throw new OpenCodeHttpError(response.status, body);
      if (response.status === 204 || !body) return undefined as T;
      try { return JSON.parse(body) as T; } catch { return body as T; }
    } finally {
      if (timer) clearTimeout(timer);
      if (forwardAbort && options.signal) options.signal.removeEventListener("abort", forwardAbort);
    }
  }

  async stream(route: string, options: { query?: Record<string, string | undefined>; signal: AbortSignal }): Promise<Response> {
    const url = new URL(route, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { headers: { accept: "text/event-stream" }, signal: options.signal });
    if (!response.ok || !response.body) throw new OpenCodeHttpError(response.status, await response.text());
    return response;
  }
}
