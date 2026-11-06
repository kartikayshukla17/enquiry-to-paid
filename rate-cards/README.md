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

## Rules-language notes (generic, no vertical in the kernel)

- `per_unit` charge: `unitAmount * max(0, value - included)`; `included` defaults to 0. Use it for "extra hours beyond the package" or any allowance another line already paid for.
- `tiered` charge: a flat amount picked by the band the `field` falls in; `upTo` is an inclusive upper bound and `null` is the open last band. The band table must cover the rule's `when` range (a value no band covers is a typed `invalid_input`), so bound the `when`.
- Coverage is expressed by the `when` conditions of `core` rules. A request no core rule covers is a `no_covering_rule` refusal, never a number.
