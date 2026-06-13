import { createRequire } from "module";
import type { IPty } from "node-pty";
import { CLAUDE_BIN } from "./config.js";
import type { Workspace } from "./types.js";

// Use createRequire to load the native CJS module from ESM
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty") as typeof import("node-pty");

export type TerminalDataCallback = (data: string) => void;
export type TerminalExitCallback = (exitCode: number) => void;

const TERMINAL_BUFFER_MAX_BYTES = 500_000;

interface TerminalSession {
  proc: IPty;
  outputBuffer: string[];
  bufferSize: number;
}

const sessions = new Map<string, TerminalSession>();

function resolveSpawn(claudeBin: string): { bin: string; cmdArgs: string[] } {
  if (process.platform !== "win32") return { bin: claudeBin, cmdArgs: [] };
  // On Windows use cmd.exe so .cmd wrappers resolve correctly
  return { bin: "cmd.exe", cmdArgs: ["/c", claudeBin] };
}

export function spawnTerminal(
  workspace: Workspace,
  initialMessage: string | undefined,
  onData: TerminalDataCallback,
  onExit: TerminalExitCallback
): void {
  if (!CLAUDE_BIN) {
    throw new Error(
      "claude CLI not found — set CLAUDE_BIN in .env to enable conductor"
    );
  }

  const { bin, cmdArgs } = resolveSpawn(CLAUDE_BIN);
  const args = initialMessage
    ? [...cmdArgs, "--message", initialMessage]
    : cmdArgs;

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (workspace.model) env["ANTHROPIC_MODEL"] = workspace.model;

  const proc = pty.spawn(bin, args, {
    name: "xterm-color",
    cols: 200,
    rows: 40,
    cwd: workspace.worktreePath,
    env,
  });

  const session: TerminalSession = { proc, outputBuffer: [], bufferSize: 0 };
  sessions.set(workspace.id, session);

  proc.onData((data: string) => {
    onData(data);
    // Accumulate into ring buffer, shedding the oldest chunks when over cap
    session.outputBuffer.push(data);
    session.bufferSize += data.length;
    while (session.bufferSize > TERMINAL_BUFFER_MAX_BYTES && session.outputBuffer.length > 1) {
      const dropped = session.outputBuffer.shift()!;
      session.bufferSize -= dropped.length;
    }
  });

  proc.onExit(({ exitCode }: { exitCode: number }) => {
    sessions.delete(workspace.id);
    onExit(exitCode);
  });
}

export function writeToTerminal(workspaceId: string, data: string): void {
  sessions.get(workspaceId)?.proc.write(data);
}

export function resizeTerminal(
  workspaceId: string,
  cols: number,
  rows: number
): void {
  sessions.get(workspaceId)?.proc.resize(cols, rows);
}

export function getBufferedOutput(workspaceId: string): string {
  const session = sessions.get(workspaceId);
  if (!session) return "";
  return session.outputBuffer.join("");
}

export function killTerminal(workspaceId: string): void {
  const session = sessions.get(workspaceId);
  if (session) {
    session.proc.kill();
    sessions.delete(workspaceId);
  }
}
