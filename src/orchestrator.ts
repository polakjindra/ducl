import EventEmitter from "events";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import {
  type Workspace,
  type WorkspaceStatus,
  type WsEvent,
  type AttachmentInput,
  TERMINAL_STATES,
} from "./types.js";
import {
  BASE_BRANCH,
  WORKTREE_BASE_PATH,
  MAX_CONCURRENT_AGENTS,
  REPO_NAME,
  runtimeConfig,
} from "./config.js";
import { conductorSettings } from "./conductorSettings.js";
import * as git from "./git.js";
import { spawnTerminal, killTerminal } from "./terminal.js";

// ── Branch naming ─────────────────────────────────────────────────────────────

function makeSlug(description: string): string {
  const raw = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return raw || "task";
}

async function makeBranch(description: string): Promise<string> {
  const slug = makeSlug(description);
  const base = `${REPO_NAME}/${slug}`;
  const valid = await git.checkRefFormat(base);
  return valid ? base : `${REPO_NAME}/task`;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  private workspaces = new Map<string, Workspace>();
  private queue: string[] = [];
  private activeCount = 0;
  private terminalExitResolvers = new Map<string, () => void>();
  private pendingAttachments = new Map<string, AttachmentInput[]>();

  constructor() {
    super();
    this.loadHistoricalWorkspaces();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async createWorkspace(
    description: string,
    baseBranch?: string,
    model?: string,
    attachments?: AttachmentInput[],
    mode: "new" | "existing" = "new",
    branchName?: string
  ): Promise<Workspace> {
    const id = randomUUID();
    const base = baseBranch ?? runtimeConfig.baseBranch;

    let branch: string;
    if (mode === "existing") {
      branch = branchName?.trim() || "unknown";
    } else {
      branch = await makeBranch(branchName || description);
    }

    const worktreePath = join(WORKTREE_BASE_PATH, id);

    const workspace: Workspace = {
      id,
      description,
      baseBranch: base,
      branch,
      worktreePath,
      status: "queued",
      logs: [],
      model: model || undefined,
      mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.workspaces.set(id, workspace);
    if (attachments && attachments.length > 0) {
      this.pendingAttachments.set(id, attachments);
    }
    this.emit_event({ type: "workspace_created", workspace: { ...workspace } });
    this.queue.push(id);
    this.dispatch();
    return workspace;
  }

  cancelWorkspace(id: string): void {
    const ws = this.workspaces.get(id);
    if (!ws || TERMINAL_STATES.has(ws.status)) return;

    if (ws.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      this.transition(ws, "cancelled");
      this.tryWriteStatus(ws, "cancelled by user");
      return;
    }

    const wasInteractive = ws.status === "interactive";
    this.transition(ws, "cancelled");
    this.tryWriteStatus(ws, "cancelled by user");

    if (wasInteractive) {
      killTerminal(id);
    }
  }

  async deleteWorkspace(id: string): Promise<void> {
    const ws = this.workspaces.get(id);
    if (!ws) return;
    if (!TERMINAL_STATES.has(ws.status)) {
      this.cancelWorkspace(id);
    }
    killTerminal(id);
    this.workspaces.delete(id);
    try {
      await git.worktreeRemove(ws.worktreePath);
    } catch {
      // best-effort; worktree may not exist or already removed
    }
  }

  getWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  // ── Historical workspaces (Phase 4) ─────────────────────────────────────────

  private loadHistoricalWorkspaces(): void {
    if (!existsSync(WORKTREE_BASE_PATH)) return;
    let names: string[];
    try {
      names = readdirSync(WORKTREE_BASE_PATH);
    } catch {
      return;
    }

    for (const name of names) {
      // Only process UUID-named directories
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) continue;
      const wsId = name;
      if (this.workspaces.has(wsId)) continue;

      const worktreePath = join(WORKTREE_BASE_PATH, wsId);
      const statusFile = join(worktreePath, ".conductor-status");
      if (!existsSync(statusFile)) continue;

      try {
        const data = JSON.parse(readFileSync(statusFile, "utf8")) as {
          status?: string;
          reason?: string;
          branch?: string;
          description?: string;
          endedAt?: string;
        };

        const status = (data.status ?? "done") as WorkspaceStatus;
        if (!TERMINAL_STATES.has(status)) continue;

        const endedAt = data.endedAt ? new Date(data.endedAt).getTime() : Date.now();

        const ws: Workspace = {
          id: wsId,
          description: data.description || data.branch || wsId,
          baseBranch: "unknown",
          branch: data.branch || "",
          worktreePath,
          status,
          logs: [],
          historical: true,
          createdAt: endedAt,
          updatedAt: endedAt,
        };

        this.workspaces.set(wsId, ws);
      } catch {
        // malformed status file, skip
      }
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private dispatch(): void {
    const cap = conductorSettings.maxConcurrentAgents ?? MAX_CONCURRENT_AGENTS;
    console.log(`[dispatch] activeCount=${this.activeCount}/${cap} queue=${this.queue.length}`);
    while (this.activeCount < cap && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const ws = this.workspaces.get(id);
      if (!ws || ws.status !== "queued") continue;
      this.activeCount++;
      console.log(`[dispatch] starting ${id.slice(0, 8)} activeCount now ${this.activeCount}`);
      this.run(ws).finally(() => {
        this.terminalExitResolvers.delete(ws.id);
        this.activeCount--;
        console.log(`[dispatch] finished ${ws.id.slice(0, 8)} activeCount now ${this.activeCount}`);
        this.dispatch();
      });
    }
    if (this.queue.length > 0) {
      console.log(`[dispatch] ${this.queue.length} task(s) queued (cap reached)`);
    }
  }

  // ── Workspace lifecycle ──────────────────────────────────────────────────────

  private async run(workspace: Workspace): Promise<void> {
    // ── PREPARING ────────────────────────────────────────────────────────────
    this.transition(workspace, "preparing");

    let worktreeCreated = false;
    try {
      // Prune stale worktree registrations before adding, to prevent
      // "already used by worktree" errors when a directory was deleted externally.
      try {
        await git.worktreePrune();
      } catch (e) {
        this.log(workspace, `prune warning (continuing): ${e}`);
      }
      if (this.isTerminal(workspace)) return;

      if (workspace.mode === "existing") {
        try {
          await git.fetchBranch(workspace.branch);
        } catch (e) {
          this.log(workspace, `fetch warning (continuing): ${e}`);
        }
        if (this.isTerminal(workspace)) return;
        await git.worktreeAddExisting(workspace.worktreePath, workspace.branch);
      } else {
        try {
          await git.fetch();
        } catch (e) {
          this.log(workspace, `fetch warning (continuing): ${e}`);
        }
        if (this.isTerminal(workspace)) return;
        await git.worktreeAdd(
          workspace.worktreePath,
          workspace.branch,
          workspace.baseBranch
        );
      }
      worktreeCreated = true;
    } catch (err) {
      this.log(workspace, `[error] worktree creation failed: ${err}`);
      if (!this.isTerminal(workspace)) {
        this.transition(workspace, "failed");
        this.tryWriteStatus(workspace, `worktree creation failed: ${err}`);
      }
      return;
    }

    if (this.isTerminal(workspace)) {
      if (worktreeCreated) {
        await git
          .worktreeRemove(workspace.worktreePath)
          .catch((e) => this.log(workspace, `cleanup warning: ${e}`));
      }
      return;
    }

    // Write attachment files if any
    const attachments = this.pendingAttachments.get(workspace.id);
    if (attachments && attachments.length > 0) {
      try {
        await this.writeAttachments(workspace, attachments);
      } catch (e) {
        this.log(workspace, `attachment warning: ${e}`);
      }
      this.pendingAttachments.delete(workspace.id);
    }

    // Build initial --message for claude (attachments only).
    const hasAttachments = attachments && attachments.length > 0;
    let initialMessage: string | undefined;
    if (hasAttachments) {
      initialMessage = workspace.description
        + "\n\nAttached files are in .conductor-attachments/ in your working directory.";
    }

    // ── INTERACTIVE ──────────────────────────────────────────────────────────
    this.transition(workspace, "interactive");

    console.log(`[run] spawning terminal for ${workspace.id.slice(0, 8)} in ${workspace.worktreePath}`);
    try {
      spawnTerminal(
        workspace,
        initialMessage,
        (data) => {
          this.emit_event({
            type: "terminal_data",
            workspaceId: workspace.id,
            data,
          });
        },
        () => {
          console.log(`[run] terminal exited for ${workspace.id.slice(0, 8)}`);
          this.handleTerminalExit(workspace);
        }
      );
    } catch (err) {
      console.error(`[run] spawn failed for ${workspace.id.slice(0, 8)}:`, err);
      this.log(workspace, `[error] failed to spawn terminal: ${err}`);
      this.transition(workspace, "failed");
      this.tryWriteStatus(workspace, `terminal spawn failed: ${err}`);
      return;
    }

    console.log(`[run] terminal_ready emitted for ${workspace.id.slice(0, 8)}`);
    this.emit_event({ type: "terminal_ready", workspaceId: workspace.id });

    await new Promise<void>((resolve) => {
      this.terminalExitResolvers.set(workspace.id, resolve);
    });
    this.terminalExitResolvers.delete(workspace.id);
  }

  private handleTerminalExit(workspace: Workspace): void {
    this.terminalExitResolvers.get(workspace.id)?.();
    if (!this.isTerminal(workspace)) {
      this.transition(workspace, "done");
      this.tryWriteStatus(workspace, "session ended");
    }
  }

  // ── Attachment writer ────────────────────────────────────────────────────────

  private async writeAttachments(workspace: Workspace, attachments: AttachmentInput[]): Promise<void> {
    const attachDir = join(workspace.worktreePath, ".conductor-attachments");
    mkdirSync(attachDir, { recursive: true });
    for (const att of attachments) {
      writeFileSync(join(attachDir, att.name), Buffer.from(att.data, "base64"));
    }
    // Append .conductor-attachments/ to .gitignore (avoid tracking uploaded files)
    const gitignorePath = join(workspace.worktreePath, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (!existing.includes(".conductor-attachments/")) {
      appendFileSync(gitignorePath, "\n.conductor-attachments/\n");
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private isTerminal(workspace: Workspace): boolean {
    return TERMINAL_STATES.has(workspace.status);
  }

  private transition(workspace: Workspace, newStatus: WorkspaceStatus): void {
    if (TERMINAL_STATES.has(workspace.status)) return;
    const oldStatus = workspace.status;
    workspace.status = newStatus;
    workspace.updatedAt = Date.now();
    this.emit_event({
      type: "workspace_state_changed",
      workspaceId: workspace.id,
      oldStatus,
      newStatus,
    });
  }

  private log(workspace: Workspace, line: string): void {
    const entry = `[${new Date().toISOString()}] ${line}`;
    workspace.logs.push(entry);
    if (workspace.logs.length > 500) workspace.logs.shift();
    this.emit_event({
      type: "workspace_log",
      workspaceId: workspace.id,
      line: entry,
      timestamp: Date.now(),
    });
  }

  private tryWriteStatus(workspace: Workspace, reason: string): void {
    try {
      writeFileSync(
        join(workspace.worktreePath, ".conductor-status"),
        JSON.stringify(
          {
            status: workspace.status,
            reason,
            branch: workspace.branch,
            description: workspace.description,
            endedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch {
      // Worktree may not exist (e.g. cancelled while queued)
    }
  }

  private emit_event(event: WsEvent): void {
    this.emit("event", event);
  }
}
