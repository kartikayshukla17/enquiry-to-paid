# Rate cards

Every card in this directory is **fictional**: invented venues, invented prices, for tests and demos only.
Each card carries `"fictional": true` and a `label` starting with `FICTIONAL:`. None is a real business's pricing.

Cards are plain JSON, interpreted by the generic Rust kernel (`kernel/`). Money is integer minor units (paise); tax is in basis points.
The card hash pinned in every quote is the SHA-256 of the canonical (key-sorted, compact) card JSON.

## Cards

| Card | What it shows |
|---|---|
| `fictional-banquet.json` | Rose Court Banquets: hall hire by weekday class, per-plate catering, tiered decor, peak-season surcharge, GST. |
| `fictional-banquet-seasonal.json` | Marigold Hall: the same engine with deliberately limited coverage (Oct-Mar, up to 250 guests). |
| `fictional-photographer.json` | Lensfolk Studio (T11): packages chosen by `package` slug with included hours, extra hours billed per hour beyond those (`per_unit` with `included`), travel by distance band (`tiered`, upper bounds inclusive), weekend surcharge, GST. Covers 1-12 hours and up to 60 km; anything else is `no_covering_rule`. |
| `fictional-b2b-supplier.json` | Brightline Fasteners (T12): unit price by volume band (`tiered_per_unit`, all-units pricing, `upTo` inclusive), a per-product MOQ with BOTH card flags (steel-bolts `refuse` below 100, nylon-ties `raise_to_min` to 500), small-order handling fee, GST. Covers up to 50,000 bolts / 200,000 ties. |
| `fictional-contractor.json` | Hearthside Repairs (T13): deliberately narrow. Three fixed-price small repairs, 1-3 items, two listed localities; everything else refuses with `no_covering_rule` and the card's `refusalSuggestion` (`book_site_visit`) with its own customer wording in `refusalSuggestionReply`. |

## Rules-language notes (generic, no vertical in the kernel)

- `refusalSuggestion` / `refusalSuggestionReply` (card level, optional): a short code the kernel echoes on `no_covering_rule` refusals (and nothing else), and the customer-facing sentence the agent appends to the holding reply. The reply text must contain no digits. Both are provided by the card; the engine invents none.

- `tiered_per_unit` charge: all-units pricing. The band the whole quantity falls in sets the unit price for every unit (`tier.amount * quantity`). `upTo` is INCLUSIVE: with bands `upTo 499 / 1999 / 50000`, 499 units is in the first band and 500 in the second. Consequence, by design and shown in the tests: 500 units can total less than 499. (Marginal/graduated pricing is a different rule and is not built.)
- `minimums` (card level): `[{ruleId, label, field, min, below, when?}]`. If an integer field is under `min` (and the optional `when` conditions hold): `below: "refuse"` returns `out_of_policy` with `ruleGap "below_minimum:<field>"` (field name only, never the value); `below: "raise_to_min"` prices at `min` and returns `adjustments: [{ruleId, label, field, from, to}]` in the quote, which the reply states using the card's own `label`. A field the customer did not give is skipped, never invented.
- Tax: each tax line is `round_half_up(subtotal * rateBps / 10_000)` in exact integer arithmetic on the pre-tax subtotal (tax lines never tax each other); the total is the exact sum of all lines.
- `per_unit` charge: `unitAmount * max(0, value - included)`; `included` defaults to 0. Use it for "extra hours beyond the package" or any allowance another line already paid for.
- `tiered` charge: a flat amount picked by the band the `field` falls in; `upTo` is an inclusive upper bound and `null` is the open last band. The band table must cover the rule's `when` range (a value no band covers is a typed `invalid_input`), so bound the `when`.
- Coverage is expressed by the `when` conditions of `core` rules. A request no core rule covers is a `no_covering_rule` refusal, never a number.
