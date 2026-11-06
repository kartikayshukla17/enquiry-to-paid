// Placeholder: real hash-chain verification (done in the Rust kernel) arrives in T4.
const [cmd] = process.argv.slice(2);
if (cmd !== "verify") {
  console.error("usage: pnpm ledger verify");
  process.exit(2);
}
console.log("ledger verify: chain verification arrives in T4 (placeholder, exit 0)");
