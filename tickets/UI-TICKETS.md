# UI tickets: Owner console

Companion to `TICKETS.md`. Same rules: every ticket is a vertical slice (data → API → screen) that ends in something you can click. All data in the test environment is fictional and labelled.

## Ruling needed first (PRD conflict)
The PRD says "No dashboard" and "Not building a dashboard, a CRM…" (v0 scope). That bound v0. These tickets are **post-v0** and deliberately small: a **read-mostly owner console**, not a CRM. The owner still lives in WhatsApp (T17/T18). The console exists to (1) show the evidence behind every number, (2) handle what WhatsApp is bad at (rate-card approval, audit, settings). Anything that looks like contact management, pipelines or reporting is out of scope.

**Framework:** build in the existing Next.js app now. Keep screens as plain React components over a typed API so T26 (React Router v8) is a move, not a rewrite.

**Design:** the site's sign-painting system (DESIGN.md): board/gold/ink, zero radius, `.panel`, `.nums`. Mobile first: owners will open this on a phone.

**Sizes:** S ≈ 1 day, M ≈ 2–3 days, L ≈ 4–5 days.

---

## Phase U-A — Foundation

### U0 — Session gate and tenant onboarding
- **Slice:** Middleware protects `/app/*` (redirect to `/login`). First sign-in with no organization lands on "Create your business" (Better Auth organization = tenant, already mirrored to `tenants`/`members`). Active organization stored in the session. Sign-out works everywhere.
- **Demo:** sign in with Google → create "FICTIONAL: Demo Banquets" → land on `/app` empty state; a second Google account sees none of it.
- **Done when:** unauthenticated `/app` redirects; a user with no org cannot reach any tenant screen; test proves user A cannot read org B.
- **Depends on:** Google sign-in (done). **Size:** M.

### U1 — Tenant-scoped read API
- **Slice:** `/api/app/*` on the agent server. Each request resolves session → active org → member role, then runs every query through `withTenant` (RLS). Typed, versioned JSON responses. Roles enforced: owner/manager/staff.
- **Demo:** `curl` with a session cookie returns only that tenant's threads; the same call with another tenant's ids returns 404.
- **Done when:** cross-tenant isolation test over every endpoint; no endpoint accepts a tenant id from the client.
- **Depends on:** U0. **Size:** M.

### U2 — App shell
- **Slice:** Layout with nav (Inbox, Quotes, Escalations, Rate card, Payments, Settings), tenant name, role badge, test-environment banner, empty/loading/error states as a reusable kit.
- **Demo:** every nav item routes to a stub with a proper empty state; works at 375px.
- **Done when:** keyboard navigable, contrast ≥ AA, no horizontal scroll on phone.
- **Depends on:** U0. **Size:** S.

---

## Phase U-B — See the evidence

### U3 — Inbox: threads and thread detail
- **Slice:** List of threads (state, last message, customer ref shown masked, age) with filters. Thread detail shows the conversation, state-machine position and which fields are still missing.
- **Demo:** run three simulator conversations; all three appear; open one and see each message with its ledger row.
- **Done when:** phone numbers never shown unmasked to staff; list paginates; open thread under 1s on seeded data.
- **Depends on:** U1, U2. **Size:** M.

### U4 — Quote and ledger viewer
- **Slice:** Each quote shown as line items with rule IDs, rate-card version/hash and `validUntil`; "Why this number" expands the rule that produced each line (reuses owner `why`). A badge shows chain status from `ledger verify`; a failing chain is shown loudly.
- **Demo:** open a quote → click a line → see the rule text; tamper in a scratch DB → badge turns red.
- **Done when:** the page renders only kernel-produced numbers (no client-side arithmetic); verify result comes from the server.
- **Depends on:** U3. **Size:** M.

### U5 — Escalation queue with takeover and handback
- **Slice:** Open escalations (reason, rule gap, thread link, age). Owner can take over a thread, reply as the human, hand back to the agent. Reuses T18 logic.
- **Demo:** send "Can you give me a discount?" in the simulator → appears in the queue → take over → agent stays silent → hand back.
- **Done when:** while taken over the agent sends nothing (test); every action is a ledger row with the acting member.
- **Depends on:** U3. **Size:** M.

---

## Phase U-C — Control

### U6 — Rate card: view, compile, approve, activate
- **Slice:** Show the active card and version history. Upload/paste a new card → compile errors shown inline → run the offline eval against it → manager approves → activate. Reuses T14 gate.
- **Demo:** break a rule, see the compile error with the line; fix, approve, activate; new quotes cite the new hash.
- **Done when:** a card that fails compile or eval cannot be activated from the UI; staff cannot approve.
- **Depends on:** U1, U2. **Size:** L.

### U7 — Payments view
- **Slice:** Payment links per quote, provider, status, amount in rupees/minor units. `collected` shown only after the webhook; nothing editable.
- **Demo:** pay a simulated Razorpay link → status flips to collected with the webhook event id.
- **Done when:** UI cannot mark anything collected; amounts reconcile with the ledger.
- **Depends on:** U4. **Size:** S.

### U8 — Settings: kill switch, chasers, members
- **Slice:** Kill switch (T28) with a confirm step. Chaser policy and consent status (T19). Members and roles: invite, change role, remove (owner only). Connected services panel (Google, payment provider, WhatsApp) showing status only.
- **Demo:** flip the kill switch → simulator refuses everything → flip back.
- **Done when:** every change is a ledger row; staff see settings read-only.
- **Depends on:** U1, U2. **Size:** M.

---

## Phase U-D — Make it believable

### U9 — Simulator inside the console
- **Slice:** Move `/simulator` into the app, scoped to the signed-in tenant and its active rate card, WhatsApp-style bubbles with the ledger card beside them on desktop.
- **Demo:** an owner tries their own rate card against test enquiries before activating it.
- **Done when:** clearly labelled test; never sends to a real channel.
- **Depends on:** U6. **Size:** S.

### U10 — Audit export
- **Slice:** Export a quote with its ledger evidence and verification result as PDF/CSV (ties to T24 Docs→PDF later; CSV first).
- **Demo:** download an export and re-verify the hashes offline with `ledger verify`.
- **Done when:** export contains no secrets or raw PII beyond what the viewer's role allows.
- **Depends on:** U4. **Size:** S.

### U11 — Marketing site truth pass and a11y/mobile sweep
- **Slice:** Landing copy updated to describe what exists (and label what doesn't). One batched audit of every console screen at phone and desktop widths.
- **Done when:** no claim without a source; Lighthouse accessibility ≥ 95 on console screens.
- **Depends on:** U3–U8. **Size:** S.

---

## Dependency map
U0 → U1 → U3 → U4 → U7, U10 · U3 → U5 · U1 → U6 → U9 · U1 → U8 · U2 alongside U0 · U11 last.

## Suggested order
Week 1: U0, U1, U2 (you can sign in and see an empty, safe shell). Week 2: U3, U4, U5 (the demo that matters: conversation → quote → evidence → takeover). Week 3: U6, U8, U7. Then U9–U11.

## Open questions
1. Do staff see customer phone numbers masked or not at all?
2. Is the console for the owner only, or also the owner's team (staff role)?
3. Is the rate card edited as JSON in-app (U6 as written) or only via Sheets (T22)? Sheets would shrink U6.
