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

### Done so far (T0-T10), one implementer subagent per ticket, all pushed to main
- T0: WASM bridge chosen (kernel/DECISION.md). T1: tracer bullet, generic rules language, CI. T2: closed refusal enum, escalation stub, proptest. T4: append-only triggers + kernel-verified per-tenant hash chain, `pnpm ledger verify`. T3: thread state, one card-defined question per missing field. T5: forced RLS, e2p_app role, AES-GCM PII, Better Auth org plugin. T6: LlmProvider, Groq adapter (live call NOT run: no key), record/replay fixtures. T7: eval harness, 37 fictional cases, RESULTS.md (recorded-fixture provider, not model accuracy). T8: intent flag, no-negotiation, disclosure EN/Hinglish/Hindi, past-date refusal, 50-case adversarial suite (0 quotes). T9: provider registry + per-language eval gate. T10: native availability, holds with exclusion constraint, durable timers, owner block commands.
- Ruling: review stage was done by the controller running the full suite (test, lint, eval --check, adversarial, ledger verify) after each ticket plus a final holistic pass, rather than a separate reviewer subagent per ticket (cost).
- Ruling: implementers chose per-ticket seams (runFixture / kernel JSON / SQL as e2p_app); their Ruling lines are in agent/README.md and commit history.
