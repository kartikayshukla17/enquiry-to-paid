# Progress ledger: v0 build (T0 to T14)

Committed ledger. Each ticket: implementer (red -> green slices via the tdd skill), then spec + quality review, then fix round if needed. All data fictional.

## Cross-cutting rulings (set up front so every ticket agrees)

- Ruling: layout is a pnpm workspace; `agent/` (TypeScript, vitest + tsx) and `kernel/` (Rust) sit beside the unchanged Next site. Root scripts `test`, `sim`, `eval`, `ledger`, `lint:agent` delegate to `agent`.
- Ruling: kernel bridge is decided in T0. Public seam for kernel tests is the JSON-in/JSON-out `evaluate` and chain functions, never internals.
- Ruling: primary test seam for pipeline tickets is the ticket's Demo command (`pnpm sim run <fixture>` equivalent: the `runFixture()` function behind it), asserting on reply text, ledger rows and thread state.
- Ruling: Postgres for tests is a real Postgres (local Docker `postgres:17-alpine` on port 54329, CI service container), via `DATABASE_URL`; PRD says 18, 17 is used because it is the available image. Each test file creates its own throwaway database.
- Ruling: tests run offline; LLM calls use recorded fixtures in `agent/src/llm/fixtures/`; Groq key only from `GROQ_API_KEY`.
- Ruling: no attribution lines in commits; conventional commits only.

## Tickets

(updated as work proceeds)
