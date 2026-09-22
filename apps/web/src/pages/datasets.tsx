import clsx from "clsx";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QualityBadge, Badge, Button, ConfirmDialog, Dialog, ErrorNote, Field, Input, Notice, PageHeader, Popover, QueryError, Skeleton } from "../components/ui";
import { useDatasetMutations, useDatasets } from "../lib/hooks";
import { ApiError } from "../lib/api";
import { fmtRelative, formatNumber } from "../lib/format";
import { useToast } from "../lib/toast";
import { useWorkspace } from "../lib/workspace";
import type { DatasetRow } from "../lib/types";

const FORMATS = "CSV, Excel (XLSX and XLS), JSON, XML, HTML tables, PDF tables, Word (DOCX), plain text and fixed-width files";

function StatusCell({ d }: { d: DatasetRow }) {
  if (d.status === "ready") return d.qualityScore != null ? <QualityBadge score={d.qualityScore} /> : <Badge tone="good">Ready</Badge>;
  if (d.status === "failed") return <Badge tone="bad">Couldn't process</Badge>;
  if (d.status === "deleting") return <Badge>Deleting</Badge>;
  return <Badge tone="thread"><span className="spinner !h-3 !w-3" aria-hidden />Processing</Badge>;
}

function UploadError({ error, wsId }: { error: unknown; wsId: string }) {
  if (error instanceof ApiError && error.isPlanLimit) return <Notice tone="warn" title="You've reached a plan limit" action={<Link to={`/w/${wsId}/usage`} className="btn btn-quiet btn-sm">See plans</Link>}>{error.message}</Notice>;
  return <ErrorNote error={error} />;
}

export function DatasetsPage() {
  const { id: wsId, can, workspace } = useWorkspace();
  const q = useDatasets(wsId);
  const m = useDatasetMutations(wsId);
  const nav = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [rename, setRename] = useState<DatasetRow | null>(null);
  const [newName, setNewName] = useState("");
  const [remove, setRemove] = useState<DatasetRow | null>(null);
  const canCreate = can("dataset.create");

  const send = (f: File | undefined) => {
    if (!f) return;
    m.upload.mutate({ file: f }, { onSuccess: (r) => nav(`/w/${wsId}/datasets/${r.datasetId}`) });
  };
  const tryDemo = () => m.demo.mutate(undefined, { onSuccess: (r) => nav(`/w/${wsId}/datasets/${r.datasetId}`) });
  const list = q.data?.datasets ?? [];
  const hasDemo = list.some((d) => d.isDemo);
  const err = m.upload.error ?? m.demo.error;
  const maxMb = Math.round(workspace.plan.limits.maxUploadBytes / 1048576);

  return (
    <div onDragOver={(e) => { if (canCreate) { e.preventDefault(); setDrag(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={(e) => { e.preventDefault(); setDrag(false); if (canCreate) send(e.dataTransfer.files[0]); }}>
      <PageHeader title="Datasets" subtitle="Upload a file and Verinum cleans it, works out what each column means, and finds what matters."
        actions={canCreate && <>
          {!hasDemo && !q.isLoading && <Button onClick={tryDemo} loading={m.demo.isPending} data-testid="try-demo">Try the demo dataset</Button>}
          <Button variant="primary" onClick={() => fileRef.current?.click()} loading={m.upload.isPending} data-testid="upload-button">Upload a file</Button>
        </>} />
      <input ref={fileRef} type="file" className="sr-only" data-testid="file-input" tabIndex={-1} aria-label="Choose a file to upload"
        accept=".csv,.tsv,.xlsx,.xls,.json,.xml,.html,.htm,.pdf,.docx,.txt,.dat,.fwf,.prn" onChange={(e) => { send(e.target.files?.[0]); e.target.value = ""; }} />
      {err && <div className="mb-4"><UploadError error={err} wsId={wsId} /></div>}

      {q.isLoading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
      {q.error && <QueryError error={q.error} retry={() => void q.refetch()} />}

      {q.data && list.length === 0 && (
        <div className={clsx("rounded-lg border-2 border-dashed px-6 py-16 text-center transition-colors", drag ? "border-thread bg-thread-wash" : "border-line-2")}>
          <h2 className="text-2xl">{canCreate ? "Drop a spreadsheet here" : "No datasets yet"}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">{canCreate ? <>Supported: {FORMATS}. Files up to {maxMb} MB on the {workspace.plan.name} plan.</> : "Ask an analyst or admin to add one."}</p>
          {canCreate && <div className="mt-6 flex justify-center gap-2"><Button variant="primary" size="lg" onClick={() => fileRef.current?.click()}>Choose a file</Button><Button size="lg" onClick={tryDemo} loading={m.demo.isPending}>Use the demo data</Button></div>}
          {canCreate && <p className="mt-4 text-xs text-ink-3">The demo is 6,764 rows of retail sales, with the kind of untidiness real files have.</p>}
        </div>
      )}

      {list.length > 0 && (
        <div className={clsx("rounded-lg", drag && "outline outline-2 outline-offset-4 outline-thread")}>
          <ul className="divide-y divide-line border-y border-line" aria-label="Datasets">
            {list.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4" data-testid="dataset-row">
                <div className="min-w-0 flex-1 basis-64">
                  <Link to={`/w/${wsId}/datasets/${d.id}`} className="block truncate font-serif text-[1.15rem] text-ink hover:text-thread">{d.name}</Link>
                  <p className="mt-0.5 truncate text-xs text-ink-3">{d.sourceName} · {d.isDemo ? "sample data" : d.sourceFormat.toUpperCase()} · updated {fmtRelative(d.updatedAt)}</p>
                </div>
                <p className="num w-40 text-sm text-ink-2">{d.rowCount != null ? `${formatNumber(d.rowCount)} rows · ${d.columnCount} columns` : "—"}</p>
                <div className="w-28"><StatusCell d={d} /></div>
                <Popover label={`Actions for ${d.name}`} align="right" trigger={({ toggle, open, id }) => <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label={`Actions for ${d.name}`}>More</Button>}>
                  {(close) => (
                    <div className="w-44">
                      <Link to={`/w/${wsId}/datasets/${d.id}`} onClick={close} className="block rounded px-2 py-1.5 text-sm hover:bg-sunk">Open</Link>
                      {can("dataset.update") && <button onClick={() => { close(); setRename(d); setNewName(d.name); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-sunk">Rename</button>}
                      {can("dataset.delete") && <button onClick={() => { close(); setRemove(d); }} className="block w-full rounded px-2 py-1.5 text-left text-sm text-down hover:bg-sunk">Delete</button>}
                    </div>
                  )}
                </Popover>
              </li>
            ))}
          </ul>
          {canCreate && <p className="mt-3 text-xs text-ink-3">Drop a file anywhere on this page to add it. Limit: {maxMb} MB per file on the {workspace.plan.name} plan.</p>}
        </div>
      )}

      <Dialog open={!!rename} onClose={() => setRename(null)} title="Rename dataset" footer={<><Button onClick={() => setRename(null)}>Cancel</Button><Button variant="primary" loading={m.rename.isPending} disabled={!newName.trim()} onClick={() => rename && m.rename.mutate({ id: rename.id, name: newName }, { onSuccess: () => { setRename(null); toast.success("Dataset renamed."); } })}>Save name</Button></>}>
        <Field label="Name">{(p) => <Input {...p} value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} autoFocus />}</Field>
        <ErrorNote className="mt-3" error={m.rename.error} />
      </Dialog>
      <ConfirmDialog open={!!remove} onClose={() => setRemove(null)} title="Delete this dataset?" confirmLabel="Delete dataset" danger loading={m.remove.isPending}
        onConfirm={() => remove && m.remove.mutate(remove.id, { onSuccess: () => { setRemove(null); toast.success("Dataset deleted. Its files are being removed."); } })}>
        <p><strong className="font-medium text-ink">{remove?.name}</strong> and everything derived from it (insights, dashboards, conversations) will be permanently deleted. This can't be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
