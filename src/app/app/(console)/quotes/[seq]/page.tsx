"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, ErrorState, LoadingState } from "@/components/app-shell/states";

/** Mirrors agent/src/server/app.ts's AppQuoteDetail (V5) — the site doesn't import agent TS across
 *  the package boundary, so this is a small site-local copy of the same shape (same precedent as
 *  inbox/[id]/page.tsx's ThreadDetail mirror). `payload` is left `unknown` here too and narrowed
 *  below by `quote.type`, never by sniffing the payload itself. */
type QuoteDetail = {
  seq: number;
  threadId: string | null;
  type: "quote" | "owner_quote";
  at: string;
  payload: unknown;
  rateCardVersion: number | null;
};
type QuoteDetailResponse = { quote: QuoteDetail };
// undefined: loading. null: a real fetch/network error. "not_found": the seq 404s (wrong tenant,
// wrong entry type, or nonexistent alike) — a distinct, calmer state from a network error.
type DetailState = QuoteDetailResponse | null | undefined | "not_found";

/** Mirrors agent/src/server/app.ts's AppLedgerVerifyResponse (V5). */
type VerifyResponse = { ok: boolean; reason?: string; seq?: number; tenantSeq?: number };
type VerifyState = VerifyResponse | null | undefined;

/** Mirrors agent/src/server/app.ts's AppPaymentView (V3b, `quoteLedgerSeq` added V12). */
type PaymentView = {
  id: string;
  threadId: string;
  quoteLedgerSeq: number;
  provider: string;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
  collectedAt: string | null;
};
type PaymentsResponse = { payments: PaymentView[] };
// undefined: loading. null: a real fetch/network error. A plain array (possibly empty) once loaded.
type PaymentsState = PaymentView[] | null | undefined;

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Minor units -> a currency-prefixed display string. Formatting a stored number for display only —
 *  no arithmetic beyond dividing by 100 and attaching a currency symbol; the ticket's "no arithmetic"
 *  rule is about never summing/recomputing a NEW fact, not about display formatting. */
function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/**
 * The chain-verify badge. Reads only what `GET /api/app/ledger-verify` returns — never computes its
 * own guess about whether the chain is intact. The same badge is correct on every quote in this
 * tenant, because it answers one question ("is this tenant's ledger chain intact") that has nothing
 * to do with which quote happens to be open.
 */
function ChainVerifyBadge({ verify }: { verify: VerifyState }) {
  if (verify === undefined) {
    return (
      <span role="status" aria-live="polite" className="inline-flex items-center gap-2 border-2 border-ink bg-board-dim px-3 py-1.5 text-xs uppercase tracking-[0.03em] text-ink/70">
        Checking ledger chain…
      </span>
    );
  }
  if (verify === null) {
    return (
      <span role="alert" className="inline-flex items-center gap-2 border-2 border-ink bg-board-dim px-3 py-1.5 text-xs uppercase tracking-[0.03em] text-ink/70">
        Could not check the ledger chain
      </span>
    );
  }
  if (verify.ok) {
    return (
      <span className="inline-flex items-center gap-2 border-2 border-ink bg-green-600 px-3 py-1.5 font-display text-xs uppercase tracking-[0.03em] text-white">
        Ledger chain intact
      </span>
    );
  }
  return (
    <span role="alert" className="inline-flex flex-col items-start gap-1 border-2 border-ink bg-signal-deep px-3 py-1.5 font-display text-xs uppercase tracking-[0.03em] text-white">
      <span>Ledger chain broken</span>
      {verify.reason && (
        <span className="font-mono text-[10px] font-normal normal-case tracking-normal">
          {verify.reason}
          {verify.seq !== undefined ? ` (row #${verify.seq})` : ""}
        </span>
      )}
    </span>
  );
}

/** A one-line, human label for a payment status, never a raw status code shown unexplained. */
function paymentStatusLabel(status: string): string {
  switch (status) {
    case "created":
      return "Link issued, not yet paid";
    case "collected":
      return "Collected";
    case "mismatch":
      return "Flagged: amount/currency mismatch";
    case "held_for_review":
      return "Held for review (quote expired)";
    case "refunded":
      return "Refunded";
    default:
      return status;
  }
}

/**
 * V12: the reconciliation view -- "the ledger says X happened to this quote" (the breakdown below, plus
 * any `payment_failed`/`payment_refunded` entries a human would see on the thread's own ledger) next to
 * "the payments table currently says Y", on one screen, so the two are visible together and a human can
 * notice if they ever disagree. This performs no drift-detection of its own (no diff, no alert) -- it is
 * exactly `GET /api/app/payments` filtered to this quote's `quoteLedgerSeq`, rendered plainly.
 */
function PaymentReconciliation({ payments, quoteSeq }: { payments: PaymentsState; quoteSeq: number }) {
  if (payments === undefined) {
    return (
      <div className="panel border-2 border-ink p-4">
        <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">Payment reconciliation</p>
        <p className="mt-2 text-sm text-ink/70">Loading payment status…</p>
      </div>
    );
  }
  if (payments === null) {
    return (
      <div className="panel border-2 border-ink p-4">
        <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">Payment reconciliation</p>
        <p className="mt-2 text-sm text-ink/70">Could not load payment status.</p>
      </div>
    );
  }
  const matches = payments.filter((p) => p.quoteLedgerSeq === quoteSeq);
  return (
    <div className="panel flex flex-col gap-3 border-2 border-ink p-4">
      <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">Payment reconciliation</p>
      {matches.length === 0 ? (
        <EmptyState title="No payment yet" body="No payment link has been issued against this quote (or this is an owner price)." />
      ) : (
        <ul className="flex flex-col gap-2">
          {matches.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/20 pb-2 last:border-b-0 last:pb-0">
              <span className="text-sm text-ink">{paymentStatusLabel(p.status)}</span>
              <span className="font-mono text-xs text-ink/60">{p.provider}</span>
              <span className="font-mono text-sm text-ink">{formatMoney(p.amountMinor, p.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * V5: the quote detail screen. Every number on it traces straight back to the kernel-produced ledger
 * payload returned by `GET /api/app/quotes/:seq` — line items, rule ids, rate-card hash/version,
 * `validUntil`, adjustments — this page performs no arithmetic of its own, only display formatting
 * (money, dates). The chain-verify badge is a separate fetch to `GET /api/app/ledger-verify`, the
 * server's real `verifyLedger` call, never a client-side guess. (V12) a third fetch to
 * `GET /api/app/payments`, filtered client-side to this quote's `seq`, backs the reconciliation panel.
 */
export default function QuoteDetailPage() {
  const params = useParams<{ seq: string }>();
  const seq = params.seq;
  const [state, setState] = useState<DetailState>(undefined);
  const [verify, setVerify] = useState<VerifyState>(undefined);
  const [payments, setPayments] = useState<PaymentsState>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/app/quotes/${encodeURIComponent(seq)}`);
        if (r.status === 404) {
          if (!cancelled) setState("not_found");
          return;
        }
        if (!r.ok) throw new Error("request failed");
        const j = (await r.json()) as QuoteDetailResponse;
        if (!cancelled) setState(j);
      } catch {
        if (!cancelled) setState(null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [seq]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/app/ledger-verify")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: VerifyResponse) => {
        if (!cancelled) setVerify(j);
      })
      .catch(() => {
        if (!cancelled) setVerify(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/app/payments")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("request failed"))))
      .then((j: PaymentsResponse) => {
        if (!cancelled) setPayments(j.payments);
      })
      .catch(() => {
        if (!cancelled) setPayments(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === undefined) return <LoadingState label="Loading quote…" />;
  if (state === null) return <ErrorState title="Could not load this quote" body="Check your connection and reload the page." />;
  if (state === "not_found") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState title="Quote not found" body="This quote does not exist, or belongs to another business." />
        <Link href="/app/quotes" className="font-display text-sm uppercase tracking-[0.03em] text-ink underline">
          Back to quotes
        </Link>
      </div>
    );
  }

  const { quote } = state;
  const p = asRecord(quote.payload);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/app/quotes" className="font-display text-sm uppercase tracking-[0.03em] text-ink underline">
          Back to quotes
        </Link>
        {quote.threadId && (
          <Link href={`/app/inbox/${encodeURIComponent(quote.threadId)}`} className="font-display text-sm uppercase tracking-[0.03em] text-ink underline">
            View thread
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">
          #{quote.seq} · {quote.type === "quote" ? "Quote" : "Owner price"} · {formatTimestamp(quote.at)}
        </span>
        <ChainVerifyBadge verify={verify} />
      </div>

      {quote.type === "quote" ? <QuoteBreakdown payload={p} rateCardVersion={quote.rateCardVersion} /> : <OwnerQuoteBreakdown payload={p} />}

      <PaymentReconciliation payments={payments} quoteSeq={quote.seq} />
    </div>
  );
}

function QuoteBreakdown({ payload, rateCardVersion }: { payload: Record<string, unknown>; rateCardVersion: number | null }) {
  const lines = Array.isArray(payload.lines) ? (payload.lines as { label: string; amount: number; ruleId: string }[]) : [];
  const adjustments = Array.isArray(payload.adjustments) ? (payload.adjustments as { ruleId: string; label: string; field: string; from: number; to: number }[]) : [];
  const currency = typeof payload.currency === "string" ? payload.currency : "INR";
  const total = typeof payload.total === "number" ? payload.total : null;
  const validUntil = typeof payload.validUntil === "string" ? payload.validUntil : null;
  const rateCardHash = typeof payload.rateCardHash === "string" ? payload.rateCardHash : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="panel flex flex-col gap-3 border-2 border-ink p-4">
        <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">Line items</p>
        {lines.length === 0 ? (
          <p className="text-sm text-ink/70">No line items on this quote.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line, i) => (
              <li key={`${line.ruleId}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/20 pb-2 last:border-b-0 last:pb-0">
                <span className="text-sm text-ink">{line.label}</span>
                <span className="font-mono text-xs text-ink/60">{line.ruleId}</span>
                <span className="font-mono text-sm text-ink">{formatMoney(line.amount, currency)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-baseline justify-between border-t-2 border-ink pt-2">
          <span className="font-display text-sm uppercase tracking-[0.03em] text-ink">Total</span>
          <span className="font-mono text-lg text-ink">{total !== null ? formatMoney(total, currency) : "unavailable"}</span>
        </div>
      </div>

      {adjustments.length > 0 && (
        <div className="panel flex flex-col gap-2 border-2 border-ink p-4">
          <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">Adjustments</p>
          <ul className="flex flex-col gap-1">
            {adjustments.map((a, i) => (
              <li key={`${a.ruleId}-${i}`} className="text-sm text-ink">
                {a.label} raised from {a.from} to {a.to}
                <span className="ml-2 font-mono text-xs text-ink/50">{a.ruleId}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel flex flex-col gap-1 border-2 border-ink p-4 text-sm text-ink">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-ink/70">Valid until</span>
          <span>{validUntil ? formatTimestamp(validUntil) : "unavailable"}</span>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-ink/70">Rate-card hash</span>
          <span className="font-mono text-xs">{rateCardHash ?? "unavailable"}</span>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span className="text-ink/70">Rate-card version</span>
          <span>{rateCardVersion !== null ? rateCardVersion : "unknown"}</span>
        </div>
      </div>
    </div>
  );
}

function OwnerQuoteBreakdown({ payload }: { payload: Record<string, unknown> }) {
  const currency = typeof payload.currency === "string" ? payload.currency : "INR";
  const total = typeof payload.total === "number" ? payload.total : null;
  const customerMessage = typeof payload.customerMessage === "string" ? payload.customerMessage : null;

  return (
    <div className="panel flex flex-col gap-3 border-2 border-ink p-4">
      <p className="font-display text-xs uppercase tracking-[0.04em] text-ink/70">
        Owner-set price — not a kernel breakdown, so there are no line items or rule ids.
      </p>
      <div className="flex items-baseline justify-between border-t-2 border-ink pt-2">
        <span className="font-display text-sm uppercase tracking-[0.03em] text-ink">Total</span>
        <span className="font-mono text-lg text-ink">{total !== null ? formatMoney(total, currency) : "unavailable"}</span>
      </div>
      {customerMessage && (
        <div className="flex flex-col gap-1 border-t border-ink/20 pt-2 text-sm text-ink">
          <span className="text-ink/70">Message sent to the customer</span>
          <span>{customerMessage}</span>
        </div>
      )}
    </div>
  );
}
