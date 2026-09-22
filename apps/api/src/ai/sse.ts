/** Minimal Server-Sent-Events reader over a fetch Response body. */
export interface SseMessage { event?: string; data: string }

export async function* readSse(res: Response): AsyncGenerator<SseMessage> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = "";
  const flush = function* (block: string): Generator<SseMessage> {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) yield { event, data: data.join("\n") };
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      yield* flush(block);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield* flush(buf);
}
