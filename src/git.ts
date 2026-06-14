import { exec } from "./util/exec.js";
import { REPO_PATH } from "./config.js";

// ── In-process async mutex ────────────────────────────────────────────────────

let gitLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitLock.then(fn);
  // The outer lock advances even if fn rejects, so the queue never jams.
  gitLock = next.then(
    () => {},
    () => {}
  );
  return next;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd = REPO_PATH) {
  return exec("git", args, { cwd });
}

function assertOk(
  result: { exitCode: number; stderr: string },
  context: string
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${context}: ${result.stderr.trim() || "(no stderr)"}`);
  }
}

// ── Locked operations (mutate shared .git state) ─────────────────────────────

export function fetch(remote = "origin"): Promise<void> {
  return withLock(async () => {
    const r = await git(["fetch", remote]);
    assertOk(r, "git fetch");
  });
}

export function fetchBranch(branch: string, remote = "origin"): Promise<void> {
  return withLock(async () => {
    const r = await git(["fetch", remote, branch]);
    assertOk(r, `git fetch ${remote} ${branch}`);
  });
}

export function worktreeAdd(
  worktreePath: string,
  branch: string,
  startPoint?: string
): Promise<void> {
  return withLock(async () => {
    const args = startPoint
      ? ["worktree", "add", "-b", branch, worktreePath, startPoint]
      : ["worktree", "add", "-b", branch, worktreePath];
    const r = await git(args);
    assertOk(r, `git worktree add ${branch}`);
  });
}

export function worktreeAddExisting(
  worktreePath: string,
  branch: string
): Promise<void> {
  return withLock(async () => {
    const r = await git(["worktree", "add", worktreePath, branch]);
    assertOk(r, `git worktree add ${branch}`);
  });
}

export function worktreeRemove(worktreePath: string): Promise<void> {
  return withLock(async () => {
    const r = await git(["worktree", "remove", "--force", worktreePath]);
    assertOk(r, `git worktree remove ${worktreePath}`);
  });
}

export function worktreePrune(): Promise<void> {
  return withLock(async () => {
    const r = await git(["worktree", "prune"]);
    assertOk(r, "git worktree prune");
  });
}

// ── Unlocked operations (operate on a single worktree) ────────────────────────

export async function diffStat(worktreePath: string): Promise<string> {
  const r = await git(["diff", "--stat", "HEAD"], worktreePath);
  return r.stdout.trim();
}

export async function hasChanges(worktreePath: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], worktreePath);
  return r.stdout.trim().length > 0;
}

export async function commit(worktreePath: string, message: string): Promise<void> {
  // Stage everything in the worktree, then commit.
  const add = await git(["add", "-A"], worktreePath);
  assertOk(add, "git add");
  const co = await git(["commit", "-m", message], worktreePath);
  // Exit code 1 with "nothing to commit" is fine; other non-zeros are errors.
  if (co.exitCode !== 0 && !co.stdout.includes("nothing to commit")) {
    assertOk(co, "git commit");
  }
}

export async function push(worktreePath: string, branch: string, remote = "origin"): Promise<void> {
  const r = await git(["push", "--set-upstream", remote, branch], worktreePath);
  assertOk(r, `git push ${branch}`);
}

/** Returns all modified file paths from `git status --porcelain` output. */
export async function modifiedPaths(worktreePath: string): Promise<string[]> {
  const r = await git(["status", "--porcelain"], worktreePath);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim()); // strip XY status prefix
}

/** Validate a git ref name. Returns true if valid. */
export async function checkRefFormat(name: string): Promise<boolean> {
  const r = await exec("git", ["check-ref-format", "--branch", name]);
  return r.exitCode === 0;
}


export interface WorktreeInfo {
  path: string;
  branch: string | null; // null when detached HEAD
  isMain: boolean;       // true for the first (main) worktree entry
}

/** Returns all worktrees registered with git, including stale ones whose directory was deleted. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const r = await git(["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return [];
  const entries: WorktreeInfo[] = [];
  const blocks = r.stdout.split(/\n\n+/);
  let isFirst = true;
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (!lines.length || !lines[0]) continue;
    let path = "";
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
    if (path) {
      entries.push({ path, branch, isMain: isFirst });
      isFirst = false;
    }
  }
  return entries;
}

/** Returns the current branch name for a worktree path. */
export async function worktreeBranchName(worktreePath: string): Promise<string> {
  const r = await git(["branch", "--show-current"], worktreePath);
  return r.stdout.trim() || "detached";
}

/** Returns the count of uncommitted changes in a worktree. */
export async function worktreeChangesCount(worktreePath: string): Promise<number> {
  const r = await git(["status", "--porcelain"], worktreePath);
  return r.stdout.trim().split("\n").filter(Boolean).length;
}

/** Removes a worktree. Pass force=true to remove even if it has uncommitted changes. */
export function worktreeRemoveControlled(worktreePath: string, force: boolean): Promise<void> {
  return withLock(async () => {
    const args = force
      ? ["worktree", "remove", "--force", worktreePath]
      : ["worktree", "remove", worktreePath];
    const r = await git(args);
    assertOk(r, `git worktree remove ${worktreePath}`);
  });
}

/** Lists all local branches under conductor/* and optionally a second prefix/*. */
export async function listLocalConductorBranches(branchPrefix?: string): Promise<string[]> {
  const patterns = ["conductor/*"];
  if (branchPrefix && branchPrefix !== "conductor") patterns.push(`${branchPrefix}/*`);
  const results = await Promise.all(
    patterns.map((pat) => git(["branch", "--list", pat, "--format=%(refname:short)"]))
  );
  const all = results.flatMap((r) => r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  return [...new Set(all)];
}

/** Lists all remote branches under conductor/* and optionally a second prefix/* (strips "origin/" prefix). */
export async function listRemoteConductorBranches(branchPrefix?: string): Promise<string[]> {
  const patterns = ["origin/conductor/*"];
  if (branchPrefix && branchPrefix !== "conductor") patterns.push(`origin/${branchPrefix}/*`);
  const results = await Promise.all(
    patterns.map((pat) => git(["branch", "-r", "--list", pat, "--format=%(refname:short)"]))
  );
  const all = results.flatMap((r) =>
    r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^origin\//, ""))
  );
  return [...new Set(all)];
}

/** Returns the ISO-8601 date of the most recent commit on a branch (local then remote fallback). */
export async function branchLastCommitDate(branch: string): Promise<string> {
  const r = await git(["log", "-1", "--format=%aI", branch]);
  if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  const r2 = await git(["log", "-1", "--format=%aI", `origin/${branch}`]);
  if (r2.exitCode === 0 && r2.stdout.trim()) return r2.stdout.trim();
  return new Date(0).toISOString();
}

/** Lists all local + remote branches, deduplicated, baseBranch first. */
export async function listRemoteBranches(baseBranch: string): Promise<string[]> {
  const [localR, remoteR] = await Promise.all([
    git(["branch", "--format=%(refname:short)"]),
    git(["branch", "-r", "--format=%(refname:short)"]),
  ]);
  const local = localR.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remote = remoteR.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("HEAD"))
    .map((l) => l.replace(/^origin\//, ""));
  const seen = new Set<string>();
  const all: string[] = [];
  for (const b of [...local, ...remote]) {
    if (!seen.has(b)) { seen.add(b); all.push(b); }
  }
  return [
    ...all.filter((b) => b === baseBranch),
    ...all.filter((b) => b !== baseBranch).sort(),
  ];
}
