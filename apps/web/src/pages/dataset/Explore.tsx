import clsx from "clsx";
import { useMemo, useState } from "react";
import { Button, Checkbox, ErrorNote, Input, Notice, Popover, QueryError, Skeleton, useDebounced } from "../../components/ui";
import { download, ApiError } from "../../lib/api";
import { useColumns, useRows } from "../../lib/hooks";
import type { Filter } from "../../lib/types";
import { formatNumber } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useDatasetCtx } from "./Layout";
import { Link } from "react-router-dom";

const PAGE = 50;

function Cell({ v, kind }: { v: string | number | boolean | null; kind: string }) {
  if (v === null || v === "") return <span className="text-ink-3">—</span>;
  if (kind === "number" && typeof v === "number") return <span className="num">{formatNumber(v, Number.isInteger(v) ? 0 : 2)}</span>;
  return <>{String(v)}</>;
}

export function ExplorePage() {
  const { wsId, dsId, versionId, dataset, can } = useDatasetCtx();
  const toast = useToast();
  const cols = useColumns(wsId, dsId, versionId);
  const [search, setSearch] = useState("");
  const dSearch = useDebounced(search, 350);
  const [cats, setCats] = useState<Record<string, string[]>>({});
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<unknown>(null);

  const dateSpec = cols.data?.filters.find((f) => f.kind === "date");
  const filters: Filter[] = useMemo(() => {
    const f: Filter[] = Object.entries(cats).filter(([, v]) => v.length).map(([column, values]) => ({ column, op: "in", values }));
    if (dateSpec && from) f.push({ column: dateSpec.column, op: "gte", value: from });
    if (dateSpec && to) f.push({ column: dateSpec.column, op: "lte", value: to });
    return f;
  }, [cats, from, to, dateSpec]);
  const body = { filters, ...(dSearch.trim() ? { search: dSearch.trim() } : {}), offset: page * PAGE, limit: PAGE, sort };
  const rows = useRows(wsId, dsId, versionId, body);
  const kinds = useMemo(() => new Map((rows.data?.columns ?? []).map((c) => [c.name, c.kind])), [rows.data]);
  const matched = rows.data?.matched ?? 0;
  const pages = Math.max(1, Math.ceil(matched / PAGE));
  const reset = () => setPage(0);

  const doExport = async (format: "csv" | "xlsx" | "json") => {
    setExporting(format); setExportErr(null);
    try { await download(`/workspaces/${wsId}/datasets/${dsId}/export`, { format, filters, ...(dSearch.trim() ? { search: dSearch.trim() } : {}), sort }, `${dataset.name}.${format}`); toast.success("Export ready."); }
    catch (e) { setExportErr(e); } finally { setExporting(null); }
  };

  if (cols.error) return <QueryError error={cols.error} retry={() => void cols.refetch()} />;
  const catFilters = (cols.data?.filters ?? []).filter((f) => f.kind === "category");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-xs"><label htmlFor="row-search" className="sr-only">Search rows</label><Input id="row-search" type="search" placeholder="Search text columns…" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} /></div>
        {dateSpec && (
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            <label className="sr-only" htmlFor="ef">From</label><input id="ef" type="date" className="input !h-10 !w-auto !px-2 text-xs" min={dateSpec.min} max={dateSpec.max} value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
            to <label className="sr-only" htmlFor="et">To</label><input id="et" type="date" className="input !h-10 !w-auto !px-2 text-xs" min={dateSpec.min} max={dateSpec.max} value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
          </span>
        )}
        {catFilters.map((f) => (
          <Popover key={f.column} label={`Filter ${f.label}`} trigger={({ toggle, open, id }) => (
            <button onClick={toggle} aria-expanded={open} aria-controls={id} className={clsx("h-10 rounded-md border px-3 text-sm", (cats[f.column]?.length ?? 0) ? "border-thread bg-thread-wash text-thread-ink" : "border-line-2 bg-panel text-ink-2 hover:text-ink")}>{f.label}{cats[f.column]?.length ? ` (${cats[f.column]!.length})` : ""}</button>)}>
            {() => (
              <div className="max-h-64 w-56 overflow-auto p-1">
                {(f.values ?? []).map((v) => <div key={v.value} className="px-1 py-1"><Checkbox checked={(cats[f.column] ?? []).includes(v.value)} onChange={(c) => { setCats((x) => ({ ...x, [f.column]: c ? [...(x[f.column] ?? []), v.value] : (x[f.column] ?? []).filter((y) => y !== v.value) })); reset(); }} label={v.value || "(blank)"} /></div>)}
              </div>
            )}
          </Popover>
        ))}
        {can("dataset.export") && (
          <div className="ml-auto">
            <Popover label="Export" align="right" trigger={({ toggle, open, id }) => <Button onClick={toggle} aria-expanded={open} aria-controls={id} loading={!!exporting}>Export</Button>}>
              {(close) => (<div className="w-52">
                <p className="px-2 py-1 text-xs text-ink-3">Exports the {formatNumber(matched)} matching rows.</p>
                {(["csv", "xlsx", "json"] as const).map((f) => <button key={f} onClick={() => { close(); void doExport(f); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-sunk">{f === "csv" ? "CSV file" : f === "xlsx" ? "Excel workbook" : "JSON"}</button>)}
              </div>)}
            </Popover>
          </div>
        )}
      </div>
      {exportErr != null && (exportErr instanceof ApiError && exportErr.isPlanLimit ? <Notice className="mt-3" tone="warn" title="Export limit reached" action={<Link className="btn btn-quiet btn-sm" to={`/w/${wsId}/usage`}>See plans</Link>}>{exportErr.message}</Notice> : <ErrorNote className="mt-3" error={exportErr} />)}

      <p className="mt-3 text-xs text-ink-3" role="status">{rows.data ? `${formatNumber(matched)} of ${formatNumber(rows.data.total)} rows` : "Loading rows…"}{rows.data && rows.data.appliedFilters.length > 0 && ` · ${rows.data.appliedFilters.join("; ")}`}</p>

      <div className={clsx("mt-2 max-h-[65vh] overflow-auto rounded-md border border-line bg-panel", rows.isFetching && rows.data && "opacity-70")} tabIndex={0} aria-label="Data rows">
        {rows.isLoading ? <Skeleton className="h-64" /> : rows.error ? <div className="p-4"><ErrorNote error={rows.error} /></div> : (
          <table className="w-max min-w-full">
            <thead className="thead sticky top-0 z-10 bg-panel">
              <tr>
                <th className="w-12 text-right">#</th>
                {rows.data!.columns.map((c) => {
                  const active = sort?.column === c.name;
                  return (
                    <th key={c.name} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button className="flex items-center gap-1 hover:text-ink" onClick={() => { setSort(active ? (sort!.dir === "asc" ? { column: c.name, dir: "desc" } : null) : { column: c.name, dir: "asc" }); reset(); }}>
                        {c.name}<span aria-hidden className="text-[9px]">{active ? (sort!.dir === "asc" ? "▲" : "▼") : ""}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.data!.rows.length === 0 && <tr><td colSpan={rows.data!.columns.length + 1} className="px-4 py-10 text-center text-sm text-ink-2">No rows match these filters.</td></tr>}
              {rows.data!.rows.map((r, i) => (
                <tr key={i} className="trow hover:bg-sunk/60">
                  <td className="num text-right text-ink-3">{formatNumber(page * PAGE + i + 1)}</td>
                  {r.map((v, j) => { const k = kinds.get(rows.data!.columns[j]!.name) ?? "string"; return <td key={j} className={clsx("max-w-[22rem] truncate", k === "number" && "text-right")} title={typeof v === "string" ? v : undefined}><Cell v={v} kind={k} /></td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-ink-2">
        <span className="num">Page {formatNumber(page + 1)} of {formatNumber(pages)}</span>
        <span className="flex gap-2"><Button size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button><Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></span>
      </div>
    </div>
  );
}
