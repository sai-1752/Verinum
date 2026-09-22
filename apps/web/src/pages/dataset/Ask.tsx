import { useSearchParams } from "react-router-dom";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { useDatasetCtx } from "./Layout";

export function AskPage() {
  const { wsId, dsId, versionId, can } = useDatasetCtx();
  const [sp] = useSearchParams();
  const q = sp.get("q");
  return <ChatPanel key={`${dsId}:${q ?? ""}`} workspaceId={wsId} datasetId={dsId} versionId={versionId} initialQuestion={q} canAsk={can("chat.ask")} />;
}
