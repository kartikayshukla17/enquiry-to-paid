# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js + Tailwind CSS + shadcn/ui with Magic UI components (user's decision, 2026-11-07). A prior single-file HTML version of the landing page exists at `docs/landing-page.html` and is treated as content truth and visual anti-reference, not as authority.

## Users

Primary: owner-operators of small physical service businesses in Delhi NCR and the GCC — banquet halls, cafés, photography studios, salons, contractors, and builders' sales desks. They run the business and answer their own enquiries. Enquiries reach them on WhatsApp, often outside working hours, in mixed Hindi-English, Urdu, Malayalam, Tagalog or Arabic. They are on a phone, mid-service, and are not at a desk.

Secondary: engineers and hiring managers who read the author's build-in-public work. They are not the audience this landing page is composed for (confirmed 2026-11-07).

## Product Purpose

One agent on one WhatsApp number that carries an enquiry the whole way: answered, priced, chased, booked, collected. Success is that no inbound enquiry goes unanswered, every enquiry gets a priced response the same hour, every quote gets chased, and every invoice gets collected.

## Positioning

Autonomous priced closure with verifiable attribution. The agent sends a real price with no human in the loop, or explicitly abstains; and an append-only ledger proves which bookings it closed, which is what makes outcome pricing billable. Verified 2026-11-07: incumbents stop at a human approval gate by design — HoneyBook drafts replies, Dubsado automates workflow, Studio Ninja ships no AI, and the Indian and Gulf WhatsApp platforms (AiSensy, Wati, Gallabox, Teammates.ai, Mando, go4whatsup) answer and route but do not advertise autonomous quoting. Industry buyer guides actively advise keeping a human on pricing and payments.

## Operating Context

WhatsApp is the channel, not a feature: business in India and the GCC happens there. Enquiries arrive as voice notes, forwarded images, and code-switched text at any hour. Pricing a job depends on facts an owner holds in their head — date class, guest count, menu tier, travel, overtime — and that they have usually never written down. Regulatory context: TRAI DLT pre-declaration for automated calls in India, DPDP duties from May 2027, UAE PDPL and WhatsApp Business API template opt-in rules.

## Capabilities and Constraints

Nothing is built yet. Confirmed design constraints: the LLM extracts parameters only and never decides a price; pricing comes from a deterministic rate card the owner approves once; an explicit refusal path ships before any autonomy claim; every quote, claimed booking and collection lands in an append-only ledger. Languages in scope: English, Hindi, Urdu, Malayalam, Tagalog, Arabic. Pricing model: per booked job or a share of collected revenue, which is unvalidated with real owners. No product name chosen.

## Brand Commitments

Vocabulary is binding: never "virtual venue," "event platform," "zones," "immersive," or "spatial" anywhere in public copy — the ICP is described as physical service businesses. Reason is contractual, recorded in `docs/COMPLIANCE-whatsapp-agent.md`. Voice: plain, measured, specific; publishes its own bad numbers; no hype. Author: Kartikay Shukla, building in public.

## Evidence on Hand

Real and usable: a public competitor comparison checked against live product and pricing pages (Nov 2026); outcome-pricing benchmarks (Intercom Fin $0.99/resolution, Zendesk $1.50–2.00, HubSpot $1.00/lead, Indian WhatsApp BSPs ₹1,350–5,000/mo); code-switching accuracy evidence (~42% WER on Hinglish for monolingual-trained models per the HiACC corpus as cited secondhand; 66.1% vs 79.4% turn-correct from a vendor benchmark); prior shipped work establishing the author's rule-engine credibility (notarize-doctor: 14 rules, 132 passing tests; EstateAI: bilingual transcript scoring against a JSON schema).

Must not be fabricated: customers, testimonials, logos, screenshots of a working product, booking volumes, revenue recovered, accuracy figures for this product's own agent. None exist. The demo conversation on the current page is a labelled worked example with a fictional business name.

## Product Principles

1. Closure over coverage — one job carried all the way beats eight modules that each stop short.
2. Determinism where the money is; the model only reads, the rules decide.
3. Abstaining is a feature, and it ships before autonomy is claimed.
4. Measured, never claimed — publish per-language numbers including the bad ones.
5. Paid out of money recovered, which obliges the ledger to be provable.

## Accessibility & Inclusion

The audience reads Devanagari, Perso-Arabic (RTL), Malayalam and Latin scripts, so type must cover them and layout must tolerate RTL. Primary device is a phone, often on mobile data, frequently one-handed and in daylight.
