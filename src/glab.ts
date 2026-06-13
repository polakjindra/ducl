import { exec } from "./util/exec.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MrStatus = 'open' | 'merged' | 'closed';

export interface MrInfo {
  mrUrl: string;
  pipelineId: string | null;
}

export type PipelineStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "no_pipeline"
  | "unknown";

// ── Helpers ───────────────────────────────────────────────────────────────────

function glab(args: string[], cwd: string) {
  return exec("glab", args, { cwd });
}

/** Extract the MR URL from glab output lines. */
function parseMrUrl(output: string): string | null {
  const match = output.match(/https?:\/\/\S+\/merge_requests\/\d+/);
  return match ? match[0] : null;
}

/** Extract the pipeline ID from `glab mr view` JSON output. */
function parsePipelineId(output: string): string | null {
  try {
    const data = JSON.parse(output) as { headPipeline?: { iid?: number; id?: number } };
    const id = data.headPipeline?.iid ?? data.headPipeline?.id;
    return id != null ? String(id) : null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Batch-fetch all MRs for conductor/* branches in one glab call.
 * Returns a map of branch name → { status, mrUrl }.
 * Filters to conductor/* source branches only (client-side).
 */
export async function listConductorMrs(
  repoPath: string
): Promise<Map<string, { status: MrStatus; mrUrl: string }>> {
  const map = new Map<string, { status: MrStatus; mrUrl: string }>();
  const result = await glab(["mr", "list", "--state", "all", "--output", "json"], repoPath);
  if (result.exitCode !== 0) return map;
  try {
    const items = JSON.parse(result.stdout) as Array<{
      source_branch?: string;
      sourceBranch?: string;
      state?: string;
      web_url?: string;
      webUrl?: string;
    }>;
    for (const item of items) {
      const branch = item.source_branch ?? item.sourceBranch ?? "";
      if (!branch.startsWith("conductor/")) continue;
      const mrUrl = item.web_url ?? item.webUrl ?? "";
      if (!mrUrl) continue;
      const raw = (item.state ?? "").toLowerCase();
      const status: MrStatus = raw === "opened" || raw === "open" ? "open"
        : raw === "merged" ? "merged"
        : "closed";
      // Keep open MR over merged/closed if multiple exist for same branch
      if (!map.has(branch) || status === "open") {
        map.set(branch, { status, mrUrl });
      }
    }
  } catch {
    // ignore parse errors — return partial/empty map
  }
  return map;
}

/**
 * Open a draft MR from `featureBranch` into `baseBranch`.
 * If one already exists for the branch, fetches and returns its URL instead.
 *
 * @param worktreePath  cwd for glab commands (must be inside the repo)
 * @param baseBranch    target branch (e.g. "main")
 * @param featureBranch source branch (e.g. "conductor/my-task/a1b2c3")
 * @param title         MR title derived from the workspace description
 */
export async function openDraftMr(
  worktreePath: string,
  baseBranch: string,
  featureBranch: string,
  title: string
): Promise<MrInfo> {
  const result = await glab(
    [
      "mr", "create",
      "--draft",
      "--title", title,
      "--source-branch", featureBranch,
      "--target-branch", baseBranch,
      "--fill",
      "--yes",
    ],
    worktreePath
  );

  if (result.exitCode === 0) {
    const mrUrl = parseMrUrl(result.stdout + result.stderr);
    if (!mrUrl) {
      throw new Error(`glab mr create succeeded but no URL found in output:\n${result.stdout}`);
    }
    // Fetch pipeline ID from the newly created MR
    const pipelineId = await fetchMrPipelineId(worktreePath, featureBranch);
    return { mrUrl, pipelineId };
  }

  // Check if the error is because an MR already exists for this branch
  const combinedOutput = result.stdout + result.stderr;
  if (/already exists|merge request.*exists/i.test(combinedOutput)) {
    return fetchExistingMr(worktreePath, featureBranch);
  }

  throw new Error(
    `glab mr create failed (exit ${result.exitCode}):\n${result.stderr.trim() || result.stdout.trim()}`
  );
}

/** Fetch info for an existing MR on the given branch. */
async function fetchExistingMr(worktreePath: string, branch: string): Promise<MrInfo> {
  const result = await glab(
    ["mr", "view", branch, "--output", "json"],
    worktreePath
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `MR already exists but could not fetch it (exit ${result.exitCode}):\n${result.stderr.trim()}`
    );
  }

  const mrUrl = parseMrUrl(result.stdout + result.stderr) ?? (() => {
    try {
      const data = JSON.parse(result.stdout) as { webUrl?: string; web_url?: string };
      return data.webUrl ?? data.web_url ?? null;
    } catch { return null; }
  })();

  if (!mrUrl) {
    throw new Error(`Could not extract MR URL from existing MR output:\n${result.stdout}`);
  }

  const pipelineId = parsePipelineId(result.stdout);
  return { mrUrl, pipelineId };
}

/** Fetch the pipeline ID for the MR on the given branch. */
async function fetchMrPipelineId(
  worktreePath: string,
  branch: string
): Promise<string | null> {
  const result = await glab(
    ["mr", "view", branch, "--output", "json"],
    worktreePath
  );
  if (result.exitCode !== 0) return null;
  return parsePipelineId(result.stdout);
}

/**
 * Get the current status of a pipeline by its ID.
 *
 * Uses `glab ci get` with the specific pipeline ID to avoid tracking
 * a wrong pipeline if a commit is pushed manually after MR creation.
 */
export async function getPipelineStatus(
  worktreePath: string,
  pipelineId: string
): Promise<PipelineStatus> {
  const result = await glab(
    ["ci", "get", "--pipeline-id", pipelineId, "--output", "json"],
    worktreePath
  );

  if (result.exitCode !== 0) {
    // Pipeline may not exist or CI is not configured
    if (/not found|no pipeline|404/i.test(result.stderr)) return "no_pipeline";
    return "unknown";
  }

  try {
    const data = JSON.parse(result.stdout) as { status?: string };
    const status = (data.status ?? "").toLowerCase();
    const MAP: Record<string, PipelineStatus> = {
      pending: "pending",
      running: "running",
      success: "passed",
      passed: "passed",
      failed: "failed",
      canceled: "cancelled",
      cancelled: "cancelled",
      skipped: "skipped",
    };
    return MAP[status] ?? "unknown";
  } catch {
    return "unknown";
  }
}
