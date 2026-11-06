# Enquiry to Paid

One agent on one WhatsApp number that carries a small business enquiry the whole way: **answered → priced → chased → booked → collected.**

No inbound enquiry goes unanswered. Every enquiry gets a priced response the same hour. Every quote gets chased. Every invoice gets collected.

> **Nothing here is built yet.** This repository currently contains the positioning, the product record, and the marketing site. There is no agent, no customer, no booking. Any claim to the contrary anywhere in this repo is a bug — report it.

---

## What we are making

A revenue-operations agent for owner-operated physical service businesses, delivered entirely inside WhatsApp. Not a dashboard, not a CRM, not a suite of eight modules. One number, one job.

The product is deliberately *one agent* because the problem is closure, not coverage. A business that owns four tools which each handle part of the money loop still loses the booking, because the gaps between the tools are where the enquiry dies.

## Why it exists

Every tool on the market stops at the same line, and it stops there on purpose.

- **HoneyBook** drafts a reply to a new enquiry and waits for you to send it.
- **Dubsado** automates the workflow around the quote, not the quote.
- **Studio Ninja** ships no AI at all.
- **AiSensy, Wati, Gallabox** (₹1,350–5,000/mo) answer a WhatsApp message in under a second and route it beautifully.
- **Teammates.ai, Mando, go4whatsup** do the same in Gulf Arabic dialects.

None of them advertises sending a price on its own. The industry's own buyer guides advise against it — one tells venue owners to treat AI as *"a fast first-response layer that hands off to humans, not an autonomous booking manager"*; another ranks lead follow-up as a good first agent and marks payments *"not first."*

That is not caution about models. It is caution about blame. **A wrong price is not a funny screenshot — it is a number a customer will hold the business to.** So the whole market sells the half of the job that does not close, and the owner still has to do the part that costs them money.

Crossing that line is the entire product.

## How it can cross that line safely

The model never decides the price.

| Layer | Does | Why it is safe |
|---|---|---|
| **LLM, narrow** | Extracts date, guest count, service, locality, language from a messy multilingual message | Cheap to be wrong — the next layer checks it |
| **Rules, deterministic** | Produces the number from a rate card the owner approves once | Same inputs, same quote, every time, with a line-by-line reason |
| **Refusal, explicit** | Declines to quote when no rule covers the case, holds the date, escalates to the owner | Abstaining is a shipped feature, not a failure mode |
| **Ledger, append-only** | Records every quote, every claimed booking, every rupee collected | Makes outcome pricing provable rather than disputable |

**The refusal path ships before any autonomy is claimed.** That ordering is not negotiable — it is what makes the rest defensible.

## Who we are targeting

**Primary:** owner-operators of small *physical* service businesses in Delhi NCR and the GCC — banquet halls, cafés, photography studios, salons, contractors, builders' sales desks.

They answer their own enquiries. Those enquiries arrive on WhatsApp, usually outside working hours, in mixed Hindi-English, Urdu, Malayalam, Tagalog or Arabic. The owner is on a phone, mid-service, not at a desk. They will never open a dashboard.

**Not the target:** enterprises, agencies, anyone with a sales team, and anyone whose customers reach them by web form.

## How we reach them

1. **One business at a time.** The first build goes to whoever will sit for an hour and explain how they actually price a Saturday. That hour is the product's hardest input, not a nice-to-have.
2. **WhatsApp and field outreach, not ads.** The buyer is not browsing. They are reachable on the same channel the product lives in.
3. **Build in public** as the credibility engine — publishing the engineering honestly, including the numbers that look bad.
4. **The site in this repo** as the artifact that makes a cold conversation warm.

## How it gets paid

**Per booked job, or a share of collected revenue.** Not per seat.

An owner can argue with ₹4,000 a month. Nobody argues with a cut of a booking that would not have existed. Closest prior art is shallow — Intercom Fin at $0.99/resolution, Zendesk at $1.50–2.00, HubSpot at $1.00/lead — and nobody was found charging per booked job for SME services.

The trap every source names: *what counts as an outcome drives the bill.* So the attribution ledger is built first. If the ledger cannot show the agent closed it, it is not billable.

**Unvalidated:** whether owner-operators in NCR and the Gulf will accept revenue share at all. Five conversations before this goes on a real price page.

## What we are deliberately not building

- **A dashboard.** A banquet owner will not open one.
- **A general assistant.** It does one job and will not pretend to be a person when asked directly.
- **"Supports 50+ languages."** Six languages, measured and published per language, including where the numbers are bad.
- **Silent guessing.** No confidence-weighted pricing, no best estimate when the rules run out.

## Honesty rules for this repository

These are product constraints, not style preferences. Do not edit them away:

- Nothing is shipped. Never write copy, commit messages, or docs that imply otherwise.
- Every conversation shown anywhere is a labelled worked example with a fictional business name.
- No fabricated customers, testimonials, logos, booking volumes, revenue figures, or accuracy numbers for our own agent.
- Every competitor claim is dated and sourced to a public product page or a named third-party guide. "Not advertised" means no public page documents it — never "they cannot."
- The ICP is described as **physical** service businesses. Never "virtual venue", "event platform", "zones", "immersive" or "spatial".

## What is in this repo today

```
enquiry-to-paid/
├── README.md              ← you are here
├── PRODUCT.md             product record: users, positioning, constraints, evidence
├── DESIGN.md              the visual system, derived from what shipped
├── prd/                   product requirements
├── tickets/               work broken down
├── src/app/               the marketing site (Next.js 15, Tailwind v4)
├── src/components/site/   its sections
└── .impeccable/           design decision records, surface brief, review captures
```

The site is the only running code. It is a Persuade surface aimed at owner-operators, built in a hand-painted Indian shop-board visual world ("The Sign Painter's Board") with six selectable enamel palettes; **Ink & Gold** is the default. See `DESIGN.md` before changing anything visual.

```bash
pnpm install --allow-build=sharp   # pnpm 12 blocks build scripts by default
pnpm build
pnpm start -p 3111
```

## Status

| | |
|---|---|
| Done | Positioning, live competitor check, product record, marketing site |
| Now | One hour with one banquet owner, writing down how they price a Saturday in December |
| Next | The rate-card kernel and its refusal path, in that order |
| Next | Per-language accuracy numbers on code-switched enquiries |
| Next | The attribution ledger, because the pricing model is void without it |

---

Built in public by Kartikay Shukla. Figures current as of November 2026.
