/**
 * Shared loading/empty/error-state kit for every /app/* console screen (V3c). V4 (inbox), V5
 * (quotes/ledger) and V6 (escalations) should import these rather than hand-rolling their own —
 * this is the lasting deliverable of the shell ticket alongside the nav itself.
 *
 * API is deliberately minimal: `<EmptyState title="..." body="..." />`, `<LoadingState />`,
 * `<ErrorState />` (optionally with an `onRetry` handler for a "Try again" button). All three
 * render inside whatever `<main>` the page already has; none of them impose their own page shell.
 */

interface StateProps {
  title: string;
  body?: string;
}

/** Nothing to show yet, and that's the expected state (e.g. an empty inbox). Not an error. */
export function EmptyState({ title, body }: StateProps) {
  return (
    <div className="panel flex flex-col items-center gap-2 p-8 text-center">
      <p className="font-display text-lg uppercase text-ink">{title}</p>
      {body && <p className="text-sm text-ink/70">{body}</p>}
    </div>
  );
}

/** A fetch is in flight. `aria-live="polite"` so screen readers hear the transition, not a spinner loop. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="panel flex flex-col items-center gap-2 p-8 text-center">
      <p className="text-sm text-ink/80">{label}</p>
    </div>
  );
}

/** A fetch failed (network/API error). `role="alert"` for immediate announcement, unlike EmptyState. */
export function ErrorState({ title = "Something went wrong", body, onRetry }: Partial<StateProps> & { onRetry?: () => void }) {
  return (
    <div role="alert" className="panel flex flex-col items-center gap-3 p-8 text-center">
      <p className="font-display text-lg uppercase text-signal-deep">{title}</p>
      {body && <p className="text-sm text-ink/70">{body}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-display border-2 border-ink bg-gold px-4 py-2 text-sm uppercase tracking-[0.03em] text-ink"
        >
          Try again
        </button>
      )}
    </div>
  );
}
