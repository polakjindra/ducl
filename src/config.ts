import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { resolve, join, basename } from "path";
import { homedir } from "os";

// DUCL_CONFIG_DIR is set by Electron's main process:
//   - packaged: app.getPath('userData')  (writable, persists updates)
//   - dev:      project root             (where .env lives)
// Falling back to cwd covers standalone `npm run dev` without Electron.
const _configDirRaw = process.env["DUCL_CONFIG_DIR"];
export const CONFIG_DIR: string = _configDirRaw ? resolve(_configDirRaw) : process.cwd();

// Load .env from CONFIG_DIR (dotenv silently skips if file is absent).
loadDotenv({ path: join(CONFIG_DIR, ".env") });

function optional_int(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`${key} must be an integer, got: ${val}`);
  return n;
}

export const REPO_PATH = (() => { const v = process.env["REPO_PATH"]; return v ? resolve(v) : ""; })();
export const WORKTREE_BASE_PATH = (() => { const v = process.env["WORKTREE_BASE_PATH"]; return v ? resolve(v) : ""; })();

// Derive a sanitized branch prefix from the managed repo's directory name.
// Falls back to "conductor" when REPO_PATH is not yet configured (first-run).
export const REPO_NAME: string = (() => {
  const raw = REPO_PATH ? basename(REPO_PATH) : "";
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/^-+|-+$/g, "");
  return slug || "conductor";
})();
export const BASE_BRANCH = process.env["BASE_BRANCH"] ?? "main";
export const MAX_CONCURRENT_AGENTS = optional_int("MAX_CONCURRENT_AGENTS", 3);
export const PORT = optional_int("PORT", 4000);

/** Mutable config values that can be updated in-memory without restart. */
export const runtimeConfig: { baseBranch: string } = {
  baseBranch: BASE_BRANCH,
};

function resolveClaudeBin(): string | undefined {
  if (process.env.CLAUDE_BIN) return resolve(process.env.CLAUDE_BIN);
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const first = out.trim().split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* not in PATH */ }
  const home = homedir();
  const candidates: string[] = process.platform === "win32"
    ? [join(home, ".local", "bin", "claude"), join(home, ".local", "bin", "claude.cmd")]
    : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

export const CLAUDE_BIN: string | undefined = resolveClaudeBin();
