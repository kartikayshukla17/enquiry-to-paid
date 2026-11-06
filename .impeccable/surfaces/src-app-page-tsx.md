---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/components/site"]
---

## Scope

The marketing landing page at `src/app/page.tsx`, composed from `src/components/site/*`. Visitor mode: **Persuade**.

## Audience and job

Owner-operators of small physical service businesses in Delhi NCR and the Gulf — banquet halls, cafés, photo studios, salons, contractors, builders' sales desks. Confirmed by the user on 2026-11-07 as the primary reader, explicitly over engineers and hiring managers. They arrive on a phone, often mid-service. Their job on this page is to recognise the money an unanswered enquiry costs them and hand over their rate card.

## Action and proof

Single action: send a WhatsApp number via the form at `#rate-card`. Proof carried on the page: a worked rate-board example where an enquiry becomes a real priced quote in seven seconds with nobody approving it; a second worked example where the agent refuses to quote and escalates; a competitor table checked against live product and pricing pages in November 2026.

## Constraints

- Nothing is shipped. No screenshot of a working product, no customer, no testimonial, no logo wall, no metric about this product's own performance. The user's single stated "feels wrong" was any page that implies it is shipped, so the Status section is loud rather than buried.
- The CTA has no backend and must say so on submit rather than showing a thank-you screen that lies.
- Vocabulary is contractually binding: never "virtual venue", "event platform", "zones", "immersive" or "spatial". Physical service businesses only. See `docs/COMPLIANCE-whatsapp-agent.md` in the parent workspace.
- Conversations shown are labelled worked examples with a fictional business name.
- Scripts in play: Latin, Devanagari, Perso-Arabic (RTL), Malayalam.

## Chosen direction

**The Sign Painter's Board** — hand-painted Indian shop boards and hoardings. Chosen by the user from the direction round (seed `e9a09983`) as Impeccable's Pick, over the roll's assignment (a mithai-shop counter world). Code-led build; no comp exists because this session had no image generation.

Pinned by the brief and preserved: a 60/30/10 colour split (cobalt ground / cream board / cadmium and vermilion signal) and ambient glow, rendered as a sodium-vapour light pool and enamel gloss rather than a neon rim.

## Memorable moment

The hero rate board: a messy Hinglish enquiry resolves into ₹3,80,000 painted on the board with a gold brush stroke struck under it, captioned "7 seconds · nobody approved it". The page's whole argument in one object.

## Unresolved

- No product name. The page is titled with the user's own phrase, "Enquiry to Paid".
- Revenue-share pricing is unvalidated with real owners; the Pricing section says so on the page.
- The CTA needs a real destination before the page is published anywhere public.
- Six of the honest-status claims depend on work not yet done; they must not drift into past tense.
