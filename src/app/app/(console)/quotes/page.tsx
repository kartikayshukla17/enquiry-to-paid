import { EmptyState } from "@/components/app-shell/states";

/** V3c stub — static, no backing read API yet. V5 replaces this with the real quotes/ledger viewer. */
export default function QuotesPage() {
  return <EmptyState title="No quotes yet" body="Quotes sent to customers will show up here." />;
}
