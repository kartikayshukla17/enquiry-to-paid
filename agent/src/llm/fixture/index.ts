import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXTRACT_PROMPT_HASH, WORD_PROMPT_HASH, sha256 } from "../prompts.js";
import {
  LlmError,
  type ExtractInput,
  type ExtractResult,
  type LlmProvider,
  type WordReplyInput,
  type WordReplyResult,
} from "../types.js";

export type LlmOp = "extract" | "wordReply";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Normalised, order-stable form of an op's input; what the recording key hashes. */
function normalise(op: LlmOp, input: ExtractInput | WordReplyInput): Record<string, string> {
  if (op === "extract") {
    const i = input as ExtractInput;
    return { text: collapse(i.text), schemaVersion: i.schemaVersion };
  }
  const i = input as WordReplyInput;
  return { kind: i.kind, template: collapse(i.template) };
}

const promptHashFor = (op: LlmOp) => (op === "extract" ? EXTRACT_PROMPT_HASH : WORD_PROMPT_HASH);

/** sha256 of (op, normalised input, prompt hash). Changing the prompt invalidates old recordings on purpose. */
export function recordingKey(op: LlmOp, input: ExtractInput | WordReplyInput): string {
  return sha256(JSON.stringify([op, normalise(op, input), promptHashFor(op)]));
}

interface Recording {
  op: LlmOp;
  input: Record<string, string>;
  promptHash: string;
  response: unknown;
}

async function load(dir: string, key: string): Promise<Recording | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")) as Recording;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Replay-only provider: answers from `<dir>/<key>.json`, fails loudly when a recording is missing. */
export function createReplayProvider(dir: string): LlmProvider {
  async function replay<T>(op: LlmOp, input: ExtractInput | WordReplyInput): Promise<T> {
    const key = recordingKey(op, input);
    const rec = await load(dir, key);
    if (!rec) {
      throw new LlmError(
        "missing_recording",
        `no recording for ${op} (key ${key}) in ${dir}; record it with LLM_PROVIDER=groq LLM_MODE=record and GROQ_API_KEY set`,
      );
    }
    return rec.response as T;
  }
  return {
    extract: (i) => replay<ExtractResult>("extract", i),
    wordReply: (i) => replay<WordReplyResult>("wordReply", i),
  };
}

/** Record mode: calls the live provider, writes the response under its key, returns it. */
export function createRecordingProvider(inner: LlmProvider, dir: string): LlmProvider {
  async function record<T>(op: LlmOp, input: ExtractInput | WordReplyInput, call: () => Promise<T>): Promise<T> {
    const response = await call();
    const rec: Recording = { op, input: normalise(op, input), promptHash: promptHashFor(op), response };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${recordingKey(op, input)}.json`), `${JSON.stringify(rec, null, 2)}\n`);
    return response;
  }
  return {
    extract: (i) => record("extract", i, () => inner.extract(i)),
    wordReply: (i) => record("wordReply", i, () => inner.wordReply(i)),
  };
}
