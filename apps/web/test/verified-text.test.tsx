import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerifiedText } from "../src/components/chat/VerifiedText";
import type { Fact, SourceRef } from "../src/lib/types";

const fact = (id: string, label: string, display: string): Fact => ({ id, label, display, value: 0, kind: "number", unit: "count" } as unknown as Fact);
const facts = [fact("c1:1", "Aura Watch: total Sales", "506.5K"), fact("c1:2", "Aura Watch: share of total", "15.7%")];
const sources = [{ callId: "c1", tool: "top_n" } as unknown as SourceRef];
const html = (text: string, mark = true) => renderToStaticMarkup(<VerifiedText text={text} facts={facts} sources={sources} mark={mark} />);
const marked = (h: string) => [...h.matchAll(/<span class="vnum"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("VerifiedText", () => {
  it("marks each figure and says which calculation it came from", () => {
    const h = html("Aura Watch leads with 506.5K, which is 15.7% of the total.");
    expect(marked(h)).toEqual(["506.5K", "15.7%"]);
    expect(h).toContain("Aura Watch: total Sales — from top_n");
  });
  it("does not mark list numbering, and renders ordered lists as lists", () => {
    const h = html("1. Aura Watch — 506.5K\n2. Nimbus Ring — 441.4K");
    expect(h).toContain("<ol");
    expect(marked(h)).toEqual(["506.5K", "441.4K"]);
  });
  it("marks nothing when marking is off (for text that was not machine-verified)", () => {
    expect(marked(html("Revenue is 506.5K.", false))).toEqual([]);
  });
  it("escapes markup in the answer rather than rendering it", () => {
    const h = html("<img src=x onerror=alert(1)> costs 506.5K");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
  it("handles signed and currency figures", () => {
    expect(marked(html("Change was +82.0% and value $1,204.50."))).toEqual(["+82.0%", "$1,204.50"]);
  });
});
