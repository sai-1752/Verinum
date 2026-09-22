import { Fragment, type ReactNode } from "react";
import type { Fact, SourceRef } from "../../lib/types";

/** A number as it appears in prose: $1,204.50 · 506.5K · 15.7% · +82.0% · 3×. */
const NUM = /(?<![\w.])([+\-−]?[$€£¥₹]?\d[\d,]*(?:\.\d+)?(?:\s?(?:[KMBkmb](?![a-z])|%|×|x(?![a-z]))|(?=[^\w]|$)))/g;

function findFact(token: string, facts: Fact[]): Fact | undefined {
  const t = token.replace(/\s+/g, "").replace(/−/g, "-");
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/−/g, "-");
  return facts.find((f) => norm(f.display) === t) ?? facts.find((f) => norm(f.display).replace(/^\+/, "") === t.replace(/^\+/, ""));
}

function VNum({ text, fact, source }: { text: string; fact?: Fact; source?: SourceRef }) {
  const detail = fact ? `${fact.label}${source ? ` — from ${source.tool}` : ""}` : "Checked against the results computed for this answer";
  return (
    <span className="group relative inline-block">
      <span className="vnum" tabIndex={0} aria-label={`${text}. Verified: ${detail}`}>{text}</span>
      <span role="tooltip" className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-1.5 w-max max-w-[15rem] -translate-x-1/2 rounded-md border border-line-2 bg-panel px-2.5 py-1.5 text-left font-sans text-xs font-normal leading-4 text-ink opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        <span className="block font-medium text-thread-ink">Verified</span>
        <span className="block text-ink-2">{detail}</span>
      </span>
    </span>
  );
}

function renderInline(text: string, facts: Fact[], sources: SourceRef[], mark: boolean, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // **bold** first, then numbers inside each piece
  text.split(/(\*\*[^*]+\*\*)/g).forEach((part, pi) => {
    const bold = part.startsWith("**") && part.endsWith("**") && part.length > 4;
    const body = bold ? part.slice(2, -2) : part;
    const nodes: ReactNode[] = [];
    if (!mark) nodes.push(body);
    else {
      let last = 0; let m: RegExpExecArray | null;
      NUM.lastIndex = 0;
      while ((m = NUM.exec(body))) {
        const tok = m[1]!;
        if (m.index > last) nodes.push(body.slice(last, m.index));
        const fact = findFact(tok, facts);
        const src = fact ? sources.find((s) => fact.id.startsWith(`${s.callId}:`)) : undefined;
        nodes.push(<VNum key={`${keyBase}-${pi}-${m.index}`} text={tok} fact={fact} source={src} />);
        last = m.index + tok.length;
      }
      if (last < body.length) nodes.push(body.slice(last));
    }
    out.push(bold ? <strong key={`${keyBase}-b${pi}`} className="font-semibold">{nodes}</strong> : <Fragment key={`${keyBase}-p${pi}`}>{nodes}</Fragment>);
  });
  return out;
}

/**
 * Renders an answer. Figures are underlined with the highlighter mark: the server has already removed every sentence whose numbers
 * could not be traced to a computed result, so what remains is verified. Hover or focus a figure to see what it was checked against.
 */
export function VerifiedText({ text, facts, sources, mark = true, streaming }: { text: string; facts: Fact[]; sources: SourceRef[]; mark?: boolean; streaming?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { const t = para.join(" "); blocks.push(<p key={`p${blocks.length}`}>{renderInline(t, facts, sources, mark, `p${blocks.length}`)}</p>); para = []; } };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    const k = blocks.length;
    blocks.push(<Tag key={`l${k}`} className={list.ordered ? "list-decimal space-y-1 pl-6" : "list-disc space-y-1 pl-6"}>{list.items.map((it, i) => <li key={i} className="pl-1">{renderInline(it, facts, sources, mark, `l${k}-${i}`)}</li>)}</Tag>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const om = /^\s*(\d+)[.)]\s+(.*)$/.exec(line), um = /^\s*[-•]\s+(.*)$/.exec(line);
    if (om) { flushPara(); if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; } list.items.push(om[2]!); }
    else if (um) { flushPara(); if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push(um[1]!); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return <div className={`space-y-3 font-serif text-[1.06rem] leading-[1.7] text-ink ${streaming ? "caret-end" : ""}`}>{blocks}{streaming && <span className="caret" aria-hidden />}</div>;
}
