/**
 * Read/write the voice prompt file.
 *
 * Path comes from config.prompt.filePath (tilde-expanded). On first read
 * with a missing file, seed it with DEFAULT_VOICE_PROMPT and ensure
 * intermediate directories exist.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { getConfig } from "../config/store.ts";
import { DEFAULT_VOICE_PROMPT } from "./default.ts";

export type PromptSnapshot = {
  path: string;
  body: string;
  mtime: number;
};

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return p.replace(/^~/, homedir());
  return p;
}

export function promptFilePath(): string {
  return expandTilde(getConfig().prompt.filePath);
}

export function readPrompt(): PromptSnapshot {
  const path = promptFilePath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_VOICE_PROMPT, "utf8");
  }
  const body = readFileSync(path, "utf8");
  const mtime = statSync(path).mtimeMs;
  return { path, body, mtime };
}

export function writePrompt(body: string): PromptSnapshot {
  const path = promptFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  const mtime = statSync(path).mtimeMs;
  return { path, body, mtime };
}

export function resetPromptToDefault(): PromptSnapshot {
  return writePrompt(DEFAULT_VOICE_PROMPT);
}
