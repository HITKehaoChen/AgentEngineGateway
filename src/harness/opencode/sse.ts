export async function consumeSse(response: Response, onData: (data: string) => Promise<void>): Promise<void> {
  if (!response.body) throw new Error("OpenCode event stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const newlineState = { pendingCR: false };
  for await (const chunk of response.body) {
    buffer += normalizeLineEndings(decoder.decode(chunk as Uint8Array, { stream: true }), newlineState);
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) await onData(data);
    }
  }
  buffer += normalizeLineEndings(decoder.decode(), newlineState, true);
  if (buffer.trim()) {
    const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) await onData(data);
  }
}

function normalizeLineEndings(value: string, state: { pendingCR: boolean }, flush = false): string {
  let output = "";
  let index = 0;
  if (state.pendingCR) {
    if (value[0] === "\n") index = 1;
    output += "\n";
    state.pendingCR = false;
  }
  for (; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\r") {
      if (index + 1 === value.length && !flush) { state.pendingCR = true; break; }
      if (value[index + 1] === "\n") index += 1;
      output += "\n";
    } else output += char;
  }
  if (flush && state.pendingCR) { output += "\n"; state.pendingCR = false; }
  return output;
}
