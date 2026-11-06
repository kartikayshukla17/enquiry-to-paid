# Rate cards

Every card in this directory is **fictional**: invented venues, invented prices, for tests and demos only.
Each card carries `"fictional": true` and a `label` starting with `FICTIONAL:`. None is a real business's pricing.

Cards are plain JSON, interpreted by the generic Rust kernel (`kernel/`). Money is integer minor units (paise); tax is in basis points.
The card hash pinned in every quote is the SHA-256 of the canonical (key-sorted, compact) card JSON.
