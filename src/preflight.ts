import { config as loadDotenv } from "dotenv";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  accessSync,
  writeFileSync,
  unlinkSync,
  constants,
} from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

loadDotenv();

// ── helpers ──────────────────────────────────────────────────────────────────

function fail(check: string, problem: string, fix: string): never {
  console.error(`✗ ${check}`);
  console.error(`  Problem: ${problem}`);
  console.error(`  Fix:     ${fix}`);
  process.exit(1);
}

function run(cmd: string, args: string[], cwd?: string): { out: string; ok: boolean } {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out: out.trim(), ok: true };
  } catch (e: unknown) {
    return { out: (e as NodeJS.ErrnoException).message ?? "", ok: false };
  }
}

function semverAtLeast(actual: string, required: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10));
  const [amaj, amin, apat] = parse(actual);
  const [rmaj, rmin, rpat] = parse(required);
  if (amaj !== rmaj) return amaj > rmaj;
  if (amin !== rmin) return amin > rmin;
  return apat >= rpat;
}

// ── checks ───────────────────────────────────────────────────────────────────

// 1. Node version >= 20
function checkNode() {
  const match = process.version.match(/^v(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;
  if (major < 20)
    fail("Node version", `${process.version} (need >= 20)`, "Install Node 20+ from https://nodejs.org");
}

// 2. Required env vars present; path vars point to existing locations
const REQUIRED_KEYS = [
  "REPO_PATH",
  "WORKTREE_BASE_PATH",
  "BASE_BRANCH",
];
const PATH_KEYS = ["REPO_PATH"];

function checkEnv(): { repoPath: string; worktreePath: string; baseBranch: string } {
  for (const key of REQUIRED_KEYS) {
    const val = process.env[key];
    if (!val)
      fail(".env / config", `${key} is missing or empty`, `Set ${key} in .env (see .env.example)`);
  }
  for (const key of PATH_KEYS) {
    const abs = resolve(process.env[key]!);
    if (!existsSync(abs))
      fail(
        ".env / config",
        `${key} does not exist: ${abs}`,
        `Create the directory or correct the path in .env`
      );
  }
  return {
    repoPath: resolve(process.env.REPO_PATH!),
    worktreePath: resolve(process.env.WORKTREE_BASE_PATH!),
    baseBranch: process.env.BASE_BRANCH!,
  };
}

// 3. Git identity in REPO_PATH
function checkGitIdentity(repoPath: string) {
  const name = run("git", ["config", "user.name"], repoPath);
  const email = run("git", ["config", "user.email"], repoPath);
  if (!name.ok || !name.out)
    fail(
      "Git identity",
      "git config user.name is not set",
      `Run: git config --global user.name "Your Name"`
    );
  if (!email.ok || !email.out)
    fail(
      "Git identity",
      "git config user.email is not set",
      `Run: git config --global user.email "you@example.com"`
    );
}

// 4. REPO_PATH is a git repo
function checkGitRepo(repoPath: string) {
  const { ok } = run("git", ["rev-parse", "--git-dir"], repoPath);
  if (!ok)
    fail(
      "Git repo",
      `${repoPath} is not a git repository`,
      "Set REPO_PATH to the root of a git-initialized directory"
    );
}

// 5. Base branch exists
function checkBaseBranch(repoPath: string, baseBranch: string) {
  const { ok } = run("git", ["rev-parse", "--verify", baseBranch], repoPath);
  if (!ok)
    fail(
      "Base branch",
      `Branch "${baseBranch}" does not exist in ${repoPath}`,
      `Set BASE_BRANCH to an existing branch (e.g. main, master)`
    );
}

// 6. glab installed and >= 1.30.0
function checkGlab() {
  const { ok, out } = run("glab", ["version"]);
  if (!ok)
    fail(
      "glab CLI",
      "glab is not installed or not on PATH",
      "Install glab >= 1.30.0: https://gitlab.com/gitlab-org/cli"
    );
  const match = out.match(/(\d+\.\d+\.\d+)/);
  if (!match)
    fail("glab CLI", `Could not parse version from: ${out}`, "Reinstall glab from https://gitlab.com/gitlab-org/cli");
  const version = match[1];
  if (!semverAtLeast(version, "1.30.0"))
    fail(
      "glab CLI",
      `glab ${version} is too old (need >= 1.30.0)`,
      "Upgrade glab: https://gitlab.com/gitlab-org/cli"
    );
}

// 7. glab authenticated
function checkGlabAuth() {
  const { ok } = run("glab", ["auth", "status"]);
  if (!ok)
    fail(
      "glab auth",
      "glab is not authenticated",
      "Run: glab auth login"
    );
}

// On Mac/Linux check both existence and executable bit.
function isExecutable(p: string): boolean {
  if (!existsSync(p)) return false;
  if (process.platform === "win32") return true;
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

// 8. claude CLI is locatable and executable (hard fail — required for all workspaces)
function checkClaudeCli() {
  const envBin = process.env.CLAUDE_BIN;
  if (envBin) {
    const abs = resolve(envBin);
    if (isExecutable(abs)) {
      console.log(`✓ claude CLI: ${abs} (from CLAUDE_BIN)`);
      return;
    }
    fail(
      "claude CLI",
      existsSync(abs)
        ? `CLAUDE_BIN exists but is not executable: ${abs}`
        : `CLAUDE_BIN is set but file does not exist: ${abs}`,
      "Fix CLAUDE_BIN in .env to point to the claude binary"
    );
  }

  // Try PATH resolution
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = run(cmd, ["claude"]);
  if (result.ok && result.out) {
    const found = result.out.split("\n")[0].trim();
    console.log(`✓ claude CLI: ${found}`);
    return;
  }

  // Platform-specific fallback locations
  const home = homedir();
  const candidates: string[] = process.platform === "win32"
    ? [join(home, ".local", "bin", "claude"), join(home, ".local", "bin", "claude.cmd")]
    : [join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
  for (const cand of candidates) {
    if (isExecutable(cand)) {
      console.log(`✓ claude CLI: ${cand} (fallback)`);
      return;
    }
  }

  fail(
    "claude CLI",
    "claude CLI not found on PATH and no fallback location exists",
    "Install Claude Code (https://claude.ai/download) or set CLAUDE_BIN in .env"
  );
}

// 9. Worktree base path writable (create if absent)
function checkWorktreePath(worktreePath: string) {
  if (!existsSync(worktreePath)) {
    try {
      mkdirSync(worktreePath, { recursive: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(
        "Worktree base path",
        `Cannot create ${worktreePath}: ${msg}`,
        "Create the directory manually or choose a writable path"
      );
    }
  }
  try {
    accessSync(worktreePath, constants.W_OK);
  } catch {
    fail(
      "Worktree base path",
      `${worktreePath} is not writable`,
      "Fix permissions or set WORKTREE_BASE_PATH to a writable directory"
    );
  }
  const probe = join(worktreePath, ".conductor-write-probe");
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(
      "Worktree base path",
      `Write probe failed at ${worktreePath}: ${msg}`,
      "Fix permissions or set WORKTREE_BASE_PATH to a writable directory"
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function preflight(): Promise<void> {
  checkNode();

  const repoPath = process.env["REPO_PATH"] ? resolve(process.env["REPO_PATH"]) : "";
  const worktreePath = process.env["WORKTREE_BASE_PATH"] ? resolve(process.env["WORKTREE_BASE_PATH"]) : "";
  const baseBranch = process.env["BASE_BRANCH"] ?? "main";

  if (repoPath && existsSync(repoPath)) {
    checkGitIdentity(repoPath);
    checkGitRepo(repoPath);
    checkBaseBranch(repoPath, baseBranch);
  } else if (!repoPath) {
    console.warn("⚠ REPO_PATH not set — first-run mode, git checks skipped");
  } else {
    console.warn(`⚠ REPO_PATH does not exist: ${repoPath} — git checks skipped`);
  }

  checkGlab();
  checkGlabAuth();
  checkClaudeCli();

  if (worktreePath) checkWorktreePath(worktreePath);

  console.log("✓ preflight passed");
}

// Run standalone when executed directly
const isMain = process.argv[1]?.endsWith("preflight.ts") ||
               process.argv[1]?.endsWith("preflight.js");
if (isMain) {
  preflight().catch((e: unknown) => {
    console.error((e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
