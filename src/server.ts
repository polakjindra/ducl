import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { statSync, existsSync, readFileSync, writeFileSync } from "fs";
import { preflight } from "./preflight.js";
import { Orchestrator } from "./orchestrator.js";
import { writeToTerminal, resizeTerminal, getBufferedOutput } from "./terminal.js";
import * as git from "./git.js";
import * as glab from "./glab.js";
import { exec } from "./util/exec.js";
import { PORT, MAX_CONCURRENT_AGENTS, WORKTREE_BASE_PATH, REPO_PATH, CLAUDE_BIN, runtimeConfig, CONFIG_DIR } from "./config.js";
import { conductorSettings } from "./conductorSettings.js";
import type { WsEvent, AttachmentInput } from "./types.js";
import { TERMINAL_STATES } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

// ── Preflight ─────────────────────────────────────────────────────────────────

await preflight();

// ── Express + HTTP server ─────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(PUBLIC_DIR));

const httpServer = createServer(app);
const orch = new Orchestrator();

// ── WebSocket relay ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

function broadcast(event: WsEvent): void {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

orch.on("event", broadcast);

wss.on("connection", (ws) => {
  // Send full snapshot on connect/reconnect so the client can rebuild state
  const snapshot: WsEvent = {
    type: "snapshot",
    workspaces: orch.getWorkspaces(),
  };
  ws.send(JSON.stringify(snapshot));

  // On reconnect, replay terminal output for all currently interactive workspaces
  for (const workspace of orch.getWorkspaces()) {
    if (workspace.status === "interactive") {
      ws.send(JSON.stringify({ type: "terminal_ready", workspaceId: workspace.id } satisfies WsEvent));
      const buf = getBufferedOutput(workspace.id);
      if (buf) {
        ws.send(JSON.stringify({ type: "terminal_replay", workspaceId: workspace.id, data: buf } satisfies WsEvent));
      }
    }
  }

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const { type, workspaceId } = msg;
    if (typeof workspaceId !== "string") return;

    if (type === "terminal_input" && typeof msg.data === "string") {
      writeToTerminal(workspaceId, msg.data);
    } else if (
      type === "terminal_resize" &&
      typeof msg.cols === "number" &&
      typeof msg.rows === "number"
    ) {
      resizeTerminal(workspaceId, msg.cols, msg.rows);
    }
  });
});

// ── REST routes ───────────────────────────────────────────────────────────────

app.get("/config", (_req, res) => {
  res.json({
    defaultModel: conductorSettings.defaultModel ?? "claude-sonnet-4-6",
    defaultBaseBranch: conductorSettings.defaultBaseBranch ?? "main",
    branchPresets: conductorSettings.branchPresets ?? {},
    maxConcurrentAgents: conductorSettings.maxConcurrentAgents ?? MAX_CONCURRENT_AGENTS,
  });
});

app.get("/branches", async (_req, res) => {
  try {
    const branches = await git.listRemoteBranches(runtimeConfig.baseBranch);
    res.json({ branches });
  } catch {
    res.json({ branches: [] });
  }
});

app.get("/workspaces", (_req, res) => {
  res.json(orch.getWorkspaces());
});

app.post("/workspaces", async (req, res) => {
  const { description, baseBranch, branchName, model, attachments, mode } = req.body as {
    description?: string;
    baseBranch?: string;
    branchName?: string;
    model?: string;
    mode?: "new" | "existing";
    attachments?: AttachmentInput[];
  };
  const desc = typeof description === "string" ? description.trim() : "";
  const wsMode: "new" | "existing" = mode === "existing" ? "existing" : "new";
  const brName = typeof branchName === "string" && branchName ? branchName.trim() : undefined;

  // Validate attachments
  const validAttachments: AttachmentInput[] = [];
  if (Array.isArray(attachments)) {
    if (attachments.length > 3) {
      res.status(400).json({ error: "max 3 attachments allowed" });
      return;
    }
    for (const att of attachments) {
      if (
        typeof att.name !== "string" ||
        typeof att.data !== "string" ||
        typeof att.size !== "number"
      ) continue;
      if (att.size > 5 * 1024 * 1024) {
        res.status(400).json({ error: `${att.name} exceeds 5MB limit` });
        return;
      }
      validAttachments.push({ name: att.name, size: att.size, data: att.data });
    }
  }

  // Resolve branch preset on baseBranch (new mode only)
  const presets = conductorSettings.branchPresets ?? {};
  const rawBranch = typeof baseBranch === "string" && baseBranch ? baseBranch : undefined;
  const resolvedBranch = rawBranch && presets[rawBranch] ? presets[rawBranch] : rawBranch;

  try {
    const workspace = await orch.createWorkspace(
      desc,
      resolvedBranch,
      typeof model === "string" && model ? model : undefined,
      validAttachments.length > 0 ? validAttachments : undefined,
      wsMode,
      brName
    );
    res.status(201).json(workspace);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/workspaces/:id/cancel", (req, res) => {
  const ws = orch.getWorkspace(req.params.id);
  if (!ws) { res.status(404).json({ error: "not found" }); return; }
  orch.cancelWorkspace(req.params.id);
  res.json({ ok: true });
});

app.delete("/workspaces/:id", async (req, res) => {
  const ws = orch.getWorkspace(req.params.id);
  if (!ws) { res.status(404).json({ error: "not found" }); return; }
  await orch.deleteWorkspace(req.params.id);
  res.json({ ok: true });
});

app.get("/worktrees", async (_req, res) => {
  try {
    // Fetch branch lists and MR data in parallel
    const [localBranches, remoteBranches, mrMap] = await Promise.all([
      git.listLocalConductorBranches().catch(() => [] as string[]),
      git.listRemoteConductorBranches().catch(() => [] as string[]),
      glab.listConductorMrs(REPO_PATH).catch(() => new Map<string, { status: glab.MrStatus; mrUrl: string }>()),
    ]);

    // Map worktree directories by the branch they have checked out.
    // Use `git worktree list --porcelain` so stale registrations (directory
    // deleted outside conductor) are detected, not silently ignored.
    const activeByPath = new Map(
      orch.getWorkspaces()
        .filter((w) => !TERMINAL_STATES.has(w.status))
        .map((w) => [w.worktreePath, w.id])
    );
    const worktreeByBranch = new Map<string, { path: string; mtime: Date; changesCount: number; dirExists: boolean }>();
    const registeredWorktrees = await git.listWorktrees().catch(() => [] as git.WorktreeInfo[]);
    await Promise.all(registeredWorktrees.map(async (wt) => {
      if (wt.isMain || !wt.branch || !wt.branch.startsWith("conductor/")) return;
      const dirExists = existsSync(wt.path);
      const stat = dirExists ? statSync(wt.path) : null;
      const changesCount = dirExists ? await git.worktreeChangesCount(wt.path).catch(() => 0) : 0;
      worktreeByBranch.set(wt.branch, { path: wt.path, mtime: stat?.mtime ?? new Date(0), changesCount, dirExists });
    }));

    // Union of all known conductor branches from any source
    const localSet = new Set(localBranches);
    const remoteSet = new Set(remoteBranches);
    const allBranches = new Set([...localSet, ...remoteSet, ...worktreeByBranch.keys()]);

    const entries = await Promise.all(
      [...allBranches].map(async (branch) => {
        const wt = worktreeByBranch.get(branch);
        const mr = mrMap.get(branch);
        const worktreePath = wt?.path ?? null;
        const isInUse = worktreePath ? activeByPath.has(worktreePath) : false;
        const lastModified = (wt?.dirExists)
          ? wt.mtime.toISOString()
          : await git.branchLastCommitDate(branch).catch(() => new Date(0).toISOString());
        return {
          branch,
          hasLocalBranch: localSet.has(branch),
          hasRemoteBranch: remoteSet.has(branch),
          hasLocalWorktree: !!wt,  // true even for stale registrations (dir deleted externally)
          worktreePath,
          hasUncommittedChanges: (wt?.dirExists && wt.changesCount > 0) ?? false,
          uncommittedCount: wt?.changesCount ?? 0,
          inUse: isInUse,
          workspaceId: isInUse && worktreePath ? (activeByPath.get(worktreePath) ?? null) : null,
          mrStatus: (mr?.status ?? "none") as glab.MrStatus | "none",
          mrUrl: mr?.mrUrl ?? null,
          lastModified,
        };
      })
    );

    entries.sort((a, b) => {
      if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
      return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
    });

    res.json({ worktrees: entries });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/worktrees", async (req, res) => {
  const { path: rawPath, force } = req.body as { path?: string; force?: boolean };
  if (!rawPath || typeof rawPath !== "string") {
    res.status(400).json({ error: "path required" }); return;
  }
  const wtPath = resolve(rawPath);
  if (!wtPath.startsWith(WORKTREE_BASE_PATH)) {
    res.status(400).json({ error: "invalid path" }); return;
  }
  const isInUse = orch.getWorkspaces()
    .filter((w) => !TERMINAL_STATES.has(w.status))
    .some((w) => w.worktreePath === wtPath);
  if (isInUse) {
    res.status(409).json({ error: "Worktree is in use by an active session" }); return;
  }
  const changesCount = await git.worktreeChangesCount(wtPath).catch(() => 0);
  if (changesCount > 0 && !force) {
    res.status(409).json({ error: "Worktree has uncommitted changes — pass force:true to delete anyway" }); return;
  }
  try {
    await git.worktreeRemoveControlled(wtPath, !!force);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Settings helpers ──────────────────────────────────────────────────────────

const ENV_FILE_PATH = join(CONFIG_DIR, ".env");

function readEnvFile(): string {
  try { return readFileSync(ENV_FILE_PATH, "utf8"); } catch { return ""; }
}

function writeEnvValues(updates: Record<string, string>): void {
  const content = readEnvFile();
  const lines = content.split(/\r?\n/);
  const updated = new Set<string>();
  const newLines = lines.map((line) => {
    for (const [key, value] of Object.entries(updates)) {
      if (new RegExp(`^${key}=`).test(line)) {
        updated.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!updated.has(key)) newLines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE_PATH, newLines.join("\n"), "utf8");
}

async function checkIsConfigured(): Promise<boolean> {
  if (!REPO_PATH || !WORKTREE_BASE_PATH) return false;
  if (!existsSync(REPO_PATH)) return false;
  const result = await exec("git", ["-C", REPO_PATH, "rev-parse", "--git-dir"]).catch(() => ({ exitCode: 1 }));
  return result.exitCode === 0;
}

async function getClaudeCliInfo(): Promise<{ found: boolean; path: string | null; version: string | null }> {
  if (!CLAUDE_BIN) return { found: false, path: null, version: null };
  try {
    const result = process.platform === "win32"
      ? await exec("cmd.exe", ["/c", CLAUDE_BIN, "--version"])
      : await exec(CLAUDE_BIN, ["--version"]);
    if (result.exitCode !== 0) return { found: true, path: CLAUDE_BIN, version: null };
    const version = result.stdout.trim().split(/\r?\n/)[0] || null;
    return { found: true, path: CLAUDE_BIN, version };
  } catch {
    return { found: true, path: CLAUDE_BIN, version: null };
  }
}

async function getGlabAuthInfo(): Promise<{ authenticated: boolean; username: string | null; host: string | null }> {
  try {
    const result = await exec("glab", ["auth", "status"]);
    const output = result.stdout + result.stderr;
    if (result.exitCode !== 0 && !output.includes("Logged in")) {
      return { authenticated: false, username: null, host: null };
    }
    const userMatch = output.match(/Logged in to \S+ as (\S+)/i) ?? output.match(/Logged in as (\S+)/i);
    const hostMatch = output.match(/Logged in to (\S+) as/i) ?? output.match(/API calls made to https?:\/\/([^/\s]+)/i);
    const username = userMatch ? userMatch[1].replace(/[()[\]]/g, "") : null;
    const host = hostMatch ? hostMatch[1] : null;
    return { authenticated: !!username, username, host };
  } catch {
    return { authenticated: false, username: null, host: null };
  }
}

app.get("/settings", async (_req, res) => {
  const activeSessionCount = orch.getWorkspaces().filter((w) => !TERMINAL_STATES.has(w.status)).length;
  const [claudeCli, gitlab, configured] = await Promise.all([
    getClaudeCliInfo(),
    getGlabAuthInfo(),
    checkIsConfigured(),
  ]);
  res.json({
    repoPath: REPO_PATH,
    worktreeBasePath: WORKTREE_BASE_PATH,
    baseBranch: runtimeConfig.baseBranch,
    activeSessionCount,
    claudeCli,
    gitlab,
    isConfigured: configured,
  });
});

app.post("/internal/restart", (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 150);
});

app.post("/settings", async (req, res) => {
  const { repoPath, worktreeBasePath, baseBranch } = req.body as {
    repoPath?: string;
    worktreeBasePath?: string;
    baseBranch?: string;
  };

  const activeSessionCount = orch.getWorkspaces().filter((w) => !TERMINAL_STATES.has(w.status)).length;
  const pathChanged =
    (repoPath !== undefined && resolve(repoPath) !== REPO_PATH) ||
    (worktreeBasePath !== undefined && resolve(worktreeBasePath) !== WORKTREE_BASE_PATH);

  if (pathChanged && activeSessionCount > 0) {
    res.status(409).json({ error: "Cannot change repo or worktree paths while sessions are active" });
    return;
  }

  const updates: Record<string, string> = {};
  if (repoPath !== undefined) updates["REPO_PATH"] = repoPath;
  if (worktreeBasePath !== undefined) updates["WORKTREE_BASE_PATH"] = worktreeBasePath;
  if (baseBranch !== undefined) updates["BASE_BRANCH"] = baseBranch;

  try {
    writeEnvValues(updates);
  } catch (err) {
    res.status(500).json({ error: `Failed to write .env: ${String(err)}` });
    return;
  }

  if (baseBranch !== undefined) runtimeConfig.baseBranch = baseBranch;

  res.json({ ok: true, requiresRestart: pathChanged });
});

// All unmatched GETs return the SPA shell
app.get("*", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`conductor running at http://127.0.0.1:${PORT}`);
});
