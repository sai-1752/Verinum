// Multi-format table extraction. Turns PDF / DOCX / JSON / XML / HTML / TXT into
// the same {columns, rows} shape the analysis engine consumes, plus candidate
// tables, provenance and honest warnings. Nothing here guesses silently.

const CDN_URL = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  fflate: "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js",
};

// In a standalone offline export these readers are inlined; window.__resources
// then holds blob URLs for them. Online, the CDN URL is used unchanged.
const resolveRes = (url) => {
  const r = typeof window !== "undefined" && window.__resources;
  return (r && typeof r[url] === "string" && r[url]) || url;
};
const CDN = {
  get pdf() { return resolveRes(CDN_URL.pdf); },
  get pdfWorker() { return resolveRes(CDN_URL.pdfWorker); },
  get fflate() { return resolveRes(CDN_URL.fflate); },
};

const loaded = {};
function loadScript(src) {
  if (loaded[src]) return loaded[src];
  loaded[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error("A required reader could not be loaded. Check your connection."));
    document.head.appendChild(s);
  });
  return loaded[src];
}

export const KIND_LABEL = {
  csv: "Delimited text", xlsx: "Spreadsheet", pdf: "PDF document", docx: "Word document",
  json: "JSON", xml: "XML", html: "HTML", txt: "Plain text",
};

export function detectKind(name) {
  const n = (name || "").toLowerCase();
  if (/\.(csv|tsv)$/.test(n)) return "csv";
  if (/\.(xlsx|xlsm|xls)$/.test(n)) return "xlsx";
  if (/\.pdf$/.test(n)) return "pdf";
  if (/\.(docx|doc)$/.test(n)) return "docx";
  if (/\.(json|ndjson|jsonl)$/.test(n)) return "json";
  if (/\.xml$/.test(n)) return "xml";
  if (/\.(html?|htm)$/.test(n)) return "html";
  if (/\.(txt|dat|log)$/.test(n)) return "txt";
  if (/\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/.test(n)) return "image";
  return null;
}

/* ------------------------------- grid helpers ------------------------------- */

const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// A grid is string[][]. Turn it into {columns, rows} using one row as header.
export function gridToTable(grid, headerRow = 0) {
  const body = grid.slice(headerRow + 1);
  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const seen = {};
  const columns = Array.from({ length: width }, (_, i) => {
    let h = clean((grid[headerRow] || [])[i]);
    if (!h) h = `column_${i + 1}`;
    seen[h] = (seen[h] || 0) + 1;
    return seen[h] > 1 ? `${h}_${seen[h]}` : h;
  });
  const rows = body
    .filter(r => r.some(c => clean(c) !== ""))
    .map(r => Object.fromEntries(columns.map((c, i) => [c, clean(r[i])])));
  return { columns, rows };
}

// Scores how table-like a grid is, and guesses which row is the header.
function scoreGrid(grid) {
  const rows = grid.filter(r => r.some(c => clean(c) !== ""));
  if (rows.length < 2) return { score: 0, headerRow: 0, note: "fewer than two populated rows" };
  const counts = rows.map(r => r.filter(c => clean(c) !== "").length);
  // Single-pass frequency map: the previous sort comparator re-filtered the whole
  // array per comparison, making this O(n² log n) and freezing on large tables.
  const freq = new Map();
  let modal = counts[0], modalN = 0;
  for (const c of counts) {
    const n = (freq.get(c) || 0) + 1;
    freq.set(c, n);
    if (n > modalN) { modalN = n; modal = c; }
  }
  const consistent = counts.filter(c => c === modal).length / counts.length;
  const width = Math.max(...counts);
  // header heuristic: the first row whose cells are mostly non-numeric while the
  // row beneath it has numbers
  let headerRow = 0;
  const numeric = r => r.filter(c => /^-?[$€£]?[\d,.\s]+%?$/.test(clean(c)) && clean(c) !== "").length;
  for (let i = 0; i < Math.min(4, rows.length - 1); i++) {
    if (numeric(rows[i]) <= 1 && numeric(rows[i + 1]) >= 1) { headerRow = i; break; }
  }
  const score = Math.min(1, (consistent * 0.6) + Math.min(0.25, rows.length / 80) + (width >= 3 ? 0.15 : 0));
  return {
    score, headerRow, rowCount: rows.length, width,
    note: consistent < 0.7 ? `cell counts vary across rows (${Math.round(consistent * 100)}% consistent) — column alignment may be wrong` : null,
  };
}

function mkTable(name, grid, extra = {}) {
  const sc = scoreGrid(grid);
  return {
    name, grid, headerRow: sc.headerRow, confidence: sc.score,
    rowCount: Math.max(0, sc.rowCount - 1), width: sc.width,
    note: sc.note, ...extra,
  };
}

/* ----------------------------------- PDF ----------------------------------- */

// Rebuilds a table from positioned text runs: rows by baseline, columns by
// clustered x-offsets. Works on PDFs with a text layer; scans have none.
async function fromPDF(file, warnings) {
  await loadScript(CDN.pdf);
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("The PDF reader could not be initialised.");
  lib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageGrids = [];
  const pageText = [];
  let anyText = false;
  const maxPages = Math.min(doc.numPages, 60);
  if (doc.numPages > maxPages) warnings.push(`The document has ${doc.numPages} pages; the first ${maxPages} were read.`);

  for (let pn = 1; pn <= maxPages; pn++) {
    const page = await doc.getPage(pn);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => clean(i.str) !== "")
      .map(i => ({
        str: clean(i.str), x: i.transform[4], y: i.transform[5],
        w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 10,
      }));
    if (!items.length) continue;
    anyText = true;

    const medH = items.map(i => i.h).sort((a, b) => a - b)[Math.floor(items.length / 2)] || 10;
    const tol = Math.max(1.5, medH * 0.55);
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= tol) { last.items.push(it); last.y = (last.y + it.y) / 2; }
      else lines.push({ y: it.y, items: [it] });
    }

    // column boundaries from clustered left edges across the page
    const xs = items.map(i => i.x).sort((a, b) => a - b);
    const gap = Math.max(4, medH * 0.9);
    const centers = [];
    let run = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] <= gap) run.push(xs[i]);
      else { centers.push(run.reduce((a, b) => a + b, 0) / run.length); run = [xs[i]]; }
    }
    centers.push(run.reduce((a, b) => a + b, 0) / run.length);
    pageText.push(lines.map(l => l.items.slice().sort((a, b) => a.x - b.x).map(i => i.str).join(" ")).join("\n"));
    if (centers.length < 2 || centers.length > 30) continue;

    const grid = lines.map(l => {
      const cells = Array(centers.length).fill("");
      l.items.sort((a, b) => a.x - b.x);
      for (const it of l.items) {
        let best = 0, bd = Infinity;
        centers.forEach((c, ci) => { const d = Math.abs(c - it.x); if (d < bd) { bd = d; best = ci; } });
        cells[best] = cells[best] ? `${cells[best]} ${it.str}` : it.str;
      }
      return cells;
    });

    // keep the longest run of rows that look like table rows (>=2 filled cells)
    let bestRun = null, cur = null;
    grid.forEach((r, i) => {
      const filled = r.filter(c => c !== "").length;
      if (filled >= 2) { if (!cur) cur = { start: i, end: i }; else cur.end = i; }
      else { if (cur && (!bestRun || cur.end - cur.start > bestRun.end - bestRun.start)) bestRun = cur; cur = null; }
    });
    if (cur && (!bestRun || cur.end - cur.start > bestRun.end - bestRun.start)) bestRun = cur;
    if (!bestRun || bestRun.end - bestRun.start < 2) continue;
    pageGrids.push({ page: pn, rows: grid.slice(bestRun.start, bestRun.end + 1) });
  }

  if (!anyText) throw new Error("This PDF has no text layer — it is almost certainly a scan or an image export. Text recognition (OCR) is not available here, so there is nothing to extract. Export the source data as CSV or XLSX instead.");
  if (!pageGrids.length) {
    // Prose, not a table — derive datasets from the text's own structure.
    const doc = structureDocument(pageText.join("\n\n"), warnings);
    if (doc) return doc;
    throw new Error("This PDF has too little text to measure. There are no rows, columns, scenes or paragraphs to analyse.");
  }

  // stitch pages whose first row matches (a table continuing across pages)
  const tables = [];
  for (const pg of pageGrids) {
    const prev = tables[tables.length - 1];
    const sig = r => r.map(c => c.toLowerCase()).join("|");
    if (prev && sig(prev.grid[0]) === sig(pg.rows[0])) { prev.grid.push(...pg.rows.slice(1)); prev.pages.push(pg.page); }
    else tables.push({ grid: pg.rows, pages: [pg.page] });
  }
  const out = tables.map(t => mkTable(
    t.pages.length > 1 ? `Table across pages ${t.pages[0]}–${t.pages[t.pages.length - 1]}` : `Table on page ${t.pages[0]}`,
    t.grid, { pages: t.pages }
  ));
  warnings.push("PDF tables are reconstructed from text positions, so column splits are inferred rather than declared. Check the preview before analysing.");
  return out;
}

/* ----------------------------------- DOCX ---------------------------------- */

async function fromDOCX(file, warnings) {
  if (/\.doc$/i.test(file.name)) throw new Error("Legacy .doc files are not readable here. Save as .docx, or export the table as CSV.");
  await loadScript(CDN.fflate);
  const buf = new Uint8Array(await file.arrayBuffer());
  let xmlText;
  try {
    const unzipped = window.fflate.unzipSync(buf, { filter: f => f.name === "word/document.xml" });
    xmlText = new TextDecoder().decode(unzipped["word/document.xml"]);
  } catch (e) { throw new Error("This .docx could not be opened. It may be corrupt or password-protected."); }
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const docText = () => [...doc.getElementsByTagName("w:p")]
    .map(p => [...p.getElementsByTagName("w:t")].map(t => t.textContent).join(""))
    .join("\n\n");
  const tbls = [...doc.getElementsByTagName("w:tbl")];
  if (!tbls.length) {
    const structured = structureDocument(docText(), warnings);
    if (structured) return structured;
    throw new Error("This document has no table and too little text to measure.");
  }
  const out = [];
  tbls.forEach((tbl, ti) => {
    const grid = [...tbl.getElementsByTagName("w:tr")].map(tr =>
      [...tr.getElementsByTagName("w:tc")].map(tc =>
        clean([...tc.getElementsByTagName("w:t")].map(t => t.textContent).join(" "))));
    if (grid.length >= 2) out.push(mkTable(`Table ${ti + 1} (${grid.length} rows)`, grid));
  });
  if (!out.length) {
    const structured = structureDocument(docText(), warnings);
    if (structured) return structured;
    throw new Error("Tables were found but none had more than one row of content.");
  }
  if (out.length > 1) warnings.push(`${out.length} tables were found in this document. Pick the one to analyse.`);
  return out;
}

/* ----------------------------- JSON / XML / HTML ---------------------------- */

function flatten(obj, prefix = "", depth = 0, out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) flatten(v, key, depth + 1, out);
    else if (Array.isArray(v)) out[key] = v.length && typeof v[0] === "object" ? `[${v.length} items]` : v.join("; ");
    else out[key] = v == null ? "" : v;
  }
  return out;
}

async function fromJSON(file, warnings) {
  const text = await file.text();
  let parsed;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length > 1 && lines.every(l => l.trim().startsWith("{"))) {
    parsed = lines.map(l => JSON.parse(l)); // ndjson
  } else {
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("This file is not valid JSON: " + e.message); }
  }
  const candidates = [];
  const consider = (val, name) => {
    if (Array.isArray(val) && val.length && typeof val[0] === "object" && !Array.isArray(val[0])) candidates.push({ name, arr: val });
  };
  consider(parsed, "Root array");
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) consider(v, k);
  }
  if (!candidates.length) throw new Error("This JSON contains no array of records. A dataset needs a list of objects with shared fields.");
  if (candidates.length > 1) warnings.push(`${candidates.length} record arrays were found. Pick the one to analyse.`);
  return candidates.map(c => {
    const flat = c.arr.map(o => flatten(o));
    const keys = [...new Set(flat.flatMap(o => Object.keys(o)))];
    const grid = [keys, ...flat.map(o => keys.map(k => (o[k] == null ? "" : String(o[k]))))];
    return mkTable(`${c.name} (${c.arr.length} records)`, grid, { headerRowFixed: true });
  });
}

async function fromXML(file, warnings) {
  const doc = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("This XML could not be parsed.");
  const byTag = new Map();
  const walk = (el) => {
    for (const ch of el.children) {
      const kids = [...ch.children];
      if (kids.length && kids.every(k => !k.children.length)) {
        const list = byTag.get(ch.tagName) || [];
        list.push(ch); byTag.set(ch.tagName, list);
      }
      walk(ch);
    }
  };
  walk(doc.documentElement);
  const best = [...byTag.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length);
  if (!best.length) throw new Error("No repeated record elements were found in this XML, so there are no rows to analyse.");
  if (best.length > 1) warnings.push(`${best.length} repeated element types were found. Pick the one that holds your records.`);
  return best.slice(0, 5).map(([tag, els]) => {
    const keys = [...new Set(els.flatMap(e => [...e.children].map(c => c.tagName)))];
    const grid = [keys, ...els.map(e => keys.map(k => { const n = e.getElementsByTagName(k)[0]; return n ? clean(n.textContent) : ""; }))];
    return mkTable(`<${tag}> × ${els.length}`, grid, { headerRowFixed: true });
  });
}

async function fromHTML(file, warnings) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, "text/html");
  const tables = [...doc.querySelectorAll("table")];
  const asDocument = () => {
    doc.querySelectorAll("script,style,noscript").forEach(n => n.remove());
    const structured = structureDocument(doc.body ? doc.body.innerText || doc.body.textContent : text, warnings);
    if (structured) return structured;
    throw new Error("This HTML file has no table and too little text to measure.");
  };
  if (!tables.length) return asDocument();
  const out = tables.map((t, i) => {
    const grid = [...t.querySelectorAll("tr")].map(tr => [...tr.querySelectorAll("th,td")].map(c => clean(c.textContent)));
    return grid.length >= 2 ? mkTable(`Table ${i + 1} (${grid.length} rows)`, grid) : null;
  }).filter(Boolean);
  if (!out.length) return asDocument();
  if (out.length > 1) warnings.push(`${out.length} tables were found. Pick the one to analyse.`);
  return out;
}

// Whitespace-aligned fixed-width text, as produced by report exports.
function fromFixedWidth(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== "").slice(0, 3000);
  if (lines.length < 3) return null;
  const width = Math.max(...lines.map(l => l.length));
  const blank = [];
  for (let c = 0; c < width; c++) {
    if (lines.every(l => (l[c] || " ") === " ")) blank.push(c);
  }
  const bounds = [0];
  for (let i = 1; i < blank.length; i++) {
    if (blank[i] !== blank[i - 1] + 1 && blank[i - 1] - (bounds[bounds.length - 1] || 0) > 1) bounds.push(blank[i - 1] + 1);
  }
  if (bounds.length < 2 || bounds.length > 25) return null;
  const grid = lines.map(l => bounds.map((b, i) => clean(l.slice(b, bounds[i + 1] === undefined ? width : bounds[i + 1]))));
  return grid;
}

/* ---------------------------- document structuring --------------------------- */

const STOP = new Set(("the a an and or but if then than that this these those of to in on at by for with from into over after before is are was were be been being am do does did done have has had having i you he she it we they them him her his hers its their our your my me us not no nor so as too very can will just don should now what which who whom where when why how all any both each few more most other some such only own same s t d ll m o re ve y ain up out off down about again further here there why").split(" "));

const words = s => (String(s).match(/[A-Za-z][A-Za-z'’]*/g) || []);
const sentences = s => String(s).split(/(?<=[.!?…])["'”’)\]]*\s+/).filter(x => words(x).length > 0);

const SLUG = /^(INT\.?\/?EXT\.?|EXT\.?\/?INT\.?|INT\.?|EXT\.?|I\/E\.?)([\s\-—:.]|$)/i;
const TRANSITION = /^(CUT TO|CUTS? TO|FADE (IN|OUT|TO)|DISSOLVE|SMASH CUT|MATCH CUT|HARD CUT|THE END|TITLE|SUPER|MONTAGE|INTERCUT|BACK TO|CONTINUED|OMITTED|END OF)\b/i;
const TIMEWORD = /\b(DAY|NIGHT|DAWN|DUSK|MORNING|AFTERNOON|EVENING|LATER|CONTINUOUS|MOMENTS LATER|SAME TIME|MIDNIGHT|SUNSET|SUNRISE)\b/i;

function isCharacterCue(t) {
  if (!t || t.length > 45) return false;
  if (SLUG.test(t) || TRANSITION.test(t)) return false;
  const core = t.replace(/\(.*?\)/g, "").replace(/[:\s]+$/, "").trim();
  if (!core || core.length < 2) return false;
  if (!/^[A-Z0-9][A-Z0-9 .,'’#&/\-]*$/.test(core)) return false;
  return /[A-Z]{2,}/.test(core);
}

function cueName(t) {
  return t.replace(/\(.*?\)/g, "").replace(/[:\s]+$/, "").trim().replace(/\s+/g, " ");
}

// A screenplay is highly structured text: scene headings and character cues are
// declared, so real per-scene and per-character datasets can be derived.
function parseScreenplay(text) {
  const lines = text.split(/\r?\n/);
  const scenes = [];
  let cur = null, speaker = null, cues = 0;
  const newScene = (heading) => {
    const h = heading.replace(/\s+/g, " ").trim();
    const body = h.replace(SLUG, "").replace(/^[\s\-—:.]+/, "").trim();
    const parts = body.split(/\s+[-—]\s+|\s{2,}/).filter(Boolean);
    let time = "", loc = body;
    if (parts.length > 1 && TIMEWORD.test(parts[parts.length - 1])) {
      time = parts.pop().trim(); loc = parts.join(" - ").trim();
    } else if (TIMEWORD.test(body)) {
      const m = body.match(TIMEWORD); time = m[0]; loc = body.replace(TIMEWORD, "").replace(/[\s\-—]+$/, "").trim();
    }
    const setting = /INT\.?\/?EXT|EXT\.?\/?INT|I\/E/i.test(h) ? "INT/EXT" : /^EXT/i.test(h) ? "EXT" : /^INT/i.test(h) ? "INT" : "";
    return {
      heading: h, setting, location: loc || "(unspecified)", time: time || "(unspecified)",
      actionWords: 0, dialogueWords: 0, dialogueLines: 0, actionLines: 0,
      speakers: new Map(), transitions: 0,
    };
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (SLUG.test(t)) { cur = newScene(t); scenes.push(cur); speaker = null; continue; }
    if (!cur) { if (!t) continue; cur = newScene("FRONT MATTER"); scenes.push(cur); }
    if (!t) { speaker = null; continue; }
    if (TRANSITION.test(t)) { cur.transitions++; speaker = null; continue; }
    if (isCharacterCue(t)) {
      speaker = cueName(t); cues++;
      cur.speakers.set(speaker, (cur.speakers.get(speaker) || 0) + 0);
      continue;
    }
    const w = words(t).length;
    if (speaker) {
      cur.dialogueWords += w; cur.dialogueLines++;
      cur.speakers.set(speaker, (cur.speakers.get(speaker) || 0) + w);
    } else { cur.actionWords += w; cur.actionLines++; }
  }
  const real = scenes.filter(s => s.heading !== "FRONT MATTER" || s.actionWords > 0);
  return { scenes: real, cues, isScreenplay: real.length >= 3 && cues >= 5 };
}

function screenplayTables(text) {
  const { scenes, cues, isScreenplay } = parseScreenplay(text);
  if (!isScreenplay) return null;
  const totalWords = scenes.reduce((a, s) => a + s.actionWords + s.dialogueWords, 0);

  const sceneCols = ["Scene", "Heading", "Setting", "Location", "TimeOfDay", "TotalWords", "ActionWords", "DialogueWords", "DialogueLines", "SpeakingCharacters", "LeadSpeaker", "EstPages", "ShareOfScript"];
  const sceneGrid = [sceneCols, ...scenes.map((s, i) => {
    const tw = s.actionWords + s.dialogueWords;
    const lead = [...s.speakers.entries()].sort((a, b) => b[1] - a[1])[0];
    return [
      String(i + 1), s.heading, s.setting, s.location, s.time,
      String(tw), String(s.actionWords), String(s.dialogueWords), String(s.dialogueLines),
      String(s.speakers.size), lead ? lead[0] : "(none)",
      (tw / 180).toFixed(2), totalWords ? ((tw / totalWords) * 100).toFixed(2) : "0",
    ];
  })];

  const chars = new Map();
  scenes.forEach((s, i) => {
    for (const [name, w] of s.speakers) {
      const c = chars.get(name) || { name, words: 0, scenes: 0, first: i + 1, last: i + 1, lines: 0 };
      c.words += w; c.scenes++; c.last = i + 1; c.first = Math.min(c.first, i + 1);
      chars.set(name, c);
    }
  });
  scenes.forEach(s => { for (const [name] of s.speakers) { const c = chars.get(name); if (c) c.lines += Math.max(1, Math.round(s.dialogueLines / Math.max(1, s.speakers.size))); } });
  const allDial = [...chars.values()].reduce((a, c) => a + c.words, 0);
  const charGrid = [
    ["Character", "DialogueWords", "ShareOfDialogue", "ScenesPresent", "SceneShare", "AvgWordsPerScene", "FirstScene", "LastScene", "SpanOfScenes"],
    ...[...chars.values()].sort((a, b) => b.words - a.words).map(c => [
      c.name, String(c.words), allDial ? ((c.words / allDial) * 100).toFixed(2) : "0",
      String(c.scenes), ((c.scenes / scenes.length) * 100).toFixed(2),
      (c.words / c.scenes).toFixed(1), String(c.first), String(c.last), String(c.last - c.first + 1),
    ]),
  ];

  return [
    mkTable(`Scenes (${scenes.length})`, sceneGrid, { headerRowFixed: true, derived: "screenplay" }),
    mkTable(`Characters (${chars.size})`, charGrid, { headerRowFixed: true, derived: "screenplay" }),
  ];
}

// Generic prose: paragraphs and term frequencies are both genuinely measurable.
function proseTables(text) {
  const blocks = text.split(/\n\s*\n+/).map(b => b.replace(/\s+/g, " ").trim()).filter(b => b);
  if (blocks.length < 3) return null;
  const isHeading = b => b.length < 70 && !/[.!?]$/.test(b) && words(b).length <= 10;
  let section = "(none)";
  const rows = [];
  blocks.forEach((b, i) => {
    if (isHeading(b)) { section = b; return; }
    const w = words(b), sn = sentences(b);
    const long = w.filter(x => x.length >= 7).length;
    rows.push([
      String(rows.length + 1), section, b.slice(0, 90),
      String(w.length), String(sn.length),
      sn.length ? (w.length / sn.length).toFixed(1) : "0",
      w.length ? ((long / w.length) * 100).toFixed(1) : "0",
      String(b.length), (b.match(/["“”]/g) || []).length > 1 ? "quoted" : "narrative",
    ]);
  });
  if (rows.length < 3) return null;
  const paraGrid = [["Index", "Section", "Preview", "Words", "Sentences", "AvgSentenceWords", "LongWordPct", "Characters", "Type"], ...rows];

  const freq = new Map();
  for (const w of words(text)) {
    const k = w.toLowerCase();
    if (k.length < 3 || STOP.has(k)) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const total = [...freq.values()].reduce((a, b) => a + b, 0);
  const termGrid = [["Term", "Count", "SharePct", "Length"],
    ...[...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300)
      .map(([t, c]) => [t, String(c), total ? ((c / total) * 100).toFixed(3) : "0", String(t.length)])];

  const out = [mkTable(`Paragraphs (${rows.length})`, paraGrid, { headerRowFixed: true, derived: "prose" })];
  if (freq.size >= 20) out.push(mkTable(`Term frequency (top ${Math.min(300, freq.size)})`, termGrid, { headerRowFixed: true, derived: "prose" }));
  return out;
}

// Turns unstructured text into analysable datasets. Screenplays, scripts and
// transcripts get structure-aware tables; anything else gets prose measures.
export function structureDocument(text, warnings = []) {
  const sp = screenplayTables(text);
  if (sp) {
    warnings.push("No data table was present, so this was read as a script: scenes and characters were derived from scene headings and character cues, and the measures below are counts of the text itself.");
    const pr = proseTables(text);
    return pr ? [...sp, ...pr.slice(1)] : sp;
  }
  const pr = proseTables(text);
  if (pr) {
    warnings.push("No data table was present, so the document was measured as prose: each row is a paragraph or a term, and the columns are counts derived from the text.");
    return pr;
  }
  return null;
}

/* --------------------------------- entrypoint -------------------------------- */

// Returns { kind, native, tables, warnings } — native means the file was already
// tabular and can go straight to analysis.
export async function extractTables(file) {
  const kind = detectKind(file.name);
  const warnings = [];
  if (kind === "image") throw new Error("Images can't be analysed: text recognition (OCR) isn't available here, so there are no rows and columns to read. Export the underlying data as CSV or XLSX.");
  if (!kind) throw new Error(`"${file.name}" isn't a recognised format. Supported: CSV, TSV, XLSX, XLS, PDF, DOCX, JSON, XML, HTML and plain text.`);

  if (kind === "csv" || kind === "xlsx") return { kind, native: true, tables: [], warnings };

  let tables;
  if (kind === "pdf") tables = await fromPDF(file, warnings);
  else if (kind === "docx") tables = await fromDOCX(file, warnings);
  else if (kind === "json") tables = await fromJSON(file, warnings);
  else if (kind === "xml") tables = await fromXML(file, warnings);
  else if (kind === "html") tables = await fromHTML(file, warnings);
  else {
    const text = await file.text();
    const fw = fromFixedWidth(text);
    if (fw) { tables = [mkTable("Fixed-width columns", fw)]; warnings.push("Columns were inferred from whitespace alignment. Check the preview."); }
    else {
      // Is it actually delimited? If not, treat it as a document.
      const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5);
      const delimited = head.length > 1 && [",", ";", "\t", "|"].some(d => head.every(l => l.split(d).length > 1));
      if (delimited) return { kind: "csv", native: true, tables: [], warnings };
      const structured = structureDocument(text, warnings);
      if (structured) tables = structured;
      else return { kind: "csv", native: true, tables: [], warnings };
    }
  }
  // Derived document tables are already in a deliberate order (scenes, then
  // characters, then terms) — only rank detected tables by table-likeness.
  if (!tables.some(t => t.derived)) tables.sort((a, b) => b.confidence * b.rowCount - a.confidence * a.rowCount);
  return { kind, native: false, tables, warnings };
}

/* --------------------------------- conversion -------------------------------- */

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(table) {
  const head = table.columns.map(csvEscape).join(",");
  const body = table.rows.map(r => table.columns.map(c => csvEscape(r[c])).join(","));
  return [head, ...body].join("\n");
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadCSV(table, baseName) {
  download(new Blob([toCSV(table)], { type: "text/csv;charset=utf-8" }), `${baseName}.csv`);
}

export function downloadXLSX(table, baseName) {
  if (!window.XLSX) { downloadCSV(table, baseName); return "csv"; }
  const aoa = [table.columns, ...table.rows.map(r => table.columns.map(c => r[c]))];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), "Data");
  const out = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
  download(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${baseName}.xlsx`);
  return "xlsx";
}
