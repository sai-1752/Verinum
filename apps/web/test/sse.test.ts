import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/lib/api";

const collect = () => { const frames: [string, string][] = []; return { frames, parse: createSseParser((e, d) => frames.push([e, d])) }; };

describe("SSE parser", () => {
  it("parses named events and default events", () => {
    const { frames, parse } = collect();
    parse('event: text\ndata: {"delta":"Hi"}\n\ndata: plain\n\n');
    expect(frames).toEqual([["text", '{"delta":"Hi"}'], ["message", "plain"]]);
  });
  it("is unaffected by where the network splits the stream, even mid-line or mid-delimiter", () => {
    const stream = 'event: tool_start\ndata: {"tool":"top_n"}\n\nevent: text\ndata: {"delta":"506.5K"}\n\nevent: final\ndata: {"ok":true}\n\n';
    const whole = collect(); whole.parse(stream);
    for (let cut = 1; cut < stream.length; cut += 7) {
      const split = collect(); split.parse(stream.slice(0, cut)); split.parse(stream.slice(cut));
      expect(split.frames).toEqual(whole.frames);
    }
    const bytewise = collect(); for (const ch of stream) bytewise.parse(ch);
    expect(bytewise.frames).toEqual(whole.frames);
  });
  it("handles CRLF line endings, comments (keep-alives) and multi-line data", () => {
    const { frames, parse } = collect();
    parse(": keep-alive\r\n\r\nevent: text\r\ndata: line one\r\ndata: line two\r\n\r\n");
    expect(frames).toEqual([["text", "line one\nline two"]]);
  });
  it("does not emit a frame until it is complete", () => {
    const { frames, parse } = collect();
    parse("event: text\ndata: partial");
    expect(frames).toEqual([]);
    parse("\n\n");
    expect(frames).toEqual([["text", "partial"]]);
  });
});
