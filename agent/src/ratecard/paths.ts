import { fileURLToPath } from "node:url";

/** The repo root (the directory that holds `rate-cards/` and `agent/`). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
