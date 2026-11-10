import { EmptyState } from "@/components/app-shell/states";

/** V3c stub — static, no backing read API yet. V6 replaces this with the real escalations queue. */
export default function EscalationsPage() {
  return <EmptyState title="No escalations" body="Enquiries that need your attention will show up here." />;
}
