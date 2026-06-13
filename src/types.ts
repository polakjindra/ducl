// Workspace lifecycle states
export type WorkspaceStatus =
  | "queued"
  | "preparing"
  | "interactive"
  | "pushing"
  | "mr_open"
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL_STATES: ReadonlySet<WorkspaceStatus> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export interface AttachmentInput {
  name: string;
  size: number;
  data: string; // base64-encoded file content
}

export interface Workspace {
  id: string;
  description: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  status: WorkspaceStatus;
  logs: string[];
  model?: string;
  mode?: "new" | "existing";
  mrUrl?: string;
  pipelineId?: string;
  historical?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── WebSocket event catalog ──────────────────────────────────────────────────

export interface WsEventWorkspaceCreated {
  type: "workspace_created";
  workspace: Workspace;
}

export interface WsEventWorkspaceStateChanged {
  type: "workspace_state_changed";
  workspaceId: string;
  oldStatus: WorkspaceStatus;
  newStatus: WorkspaceStatus;
}

export interface WsEventWorkspaceLog {
  type: "workspace_log";
  workspaceId: string;
  line: string;
  timestamp: number;
}

export interface WsEventSnapshot {
  type: "snapshot";
  workspaces: Workspace[];
}

export interface WsEventTerminalReady {
  type: "terminal_ready";
  workspaceId: string;
}

export interface WsEventTerminalData {
  type: "terminal_data";
  workspaceId: string;
  data: string;
}

export interface WsEventTerminalReplay {
  type: "terminal_replay";
  workspaceId: string;
  data: string;
}

export type WsEvent =
  | WsEventSnapshot
  | WsEventWorkspaceCreated
  | WsEventWorkspaceStateChanged
  | WsEventWorkspaceLog
  | WsEventTerminalReady
  | WsEventTerminalData
  | WsEventTerminalReplay;
