# conductor-gitlab

A local quality-of-life tool that runs several Claude Code agents in parallel — each in its own git worktree on its own branch — and ships each finished task as a GitLab merge request, all watched from a small web console. The point is to let a handful of agents work different branches at once without stepping on each other or leaving a mess behind. It is single-user and runs as one local process; state lives in memory, while git and GitLab hold the durable record (branches, commits, MRs).

## How it works

The unit of work is a **workspace**: one task → one branch → one git worktree → one Claude session. A workspace moves through a fixed set of states:

```
queued → preparing → running ──────────────────────────→ pushing → mr_open → done
                        │                                                   ↘ failed
                        ├─→ awaiting_permission → (approved) → running
                        │                       → (denied / timeout) → failed
                        │
                        └─→ awaiting_input → (follow-up received) → running
                                           → (cancelled) → cancelled

any non-terminal state → cancelled
```

The flow: you create a task, it queues. When a concurrency slot frees up it gets a fresh worktree on a new branch cut from the latest commit of the base branch, and one Claude agent works the task inside that worktree only. A turn runs the agent's full tool loop until it finishes or asks a question.

**End-of-turn decision rule:** when a turn ends, check the worktree for changes (committed or uncommitted). If there are any changes, commit any remainder, push the branch, and open a draft MR → `pushing`. If there are zero changes and the agent's output contains a question, enter `awaiting_input`. An agent that both makes changes and asks a question is treated as having changes (push path). Follow-ups resume the same Claude session so context is preserved.

Every tool the agent wants to run is checked by a permission policy: safe things (reads, in-worktree edits, a safelisted set of shell commands) run silently, clearly dangerous things are blocked outright, and anything ambiguous pauses the agent and asks you in the console — with a timeout so an unattended agent can never hang. Worktrees and branches are left in place when a task ends; nothing is deleted automatically — you remove a worktree yourself when you're done with it.

### Branch naming

Every workspace branch follows the pattern `conductor/<slug>/<id>` where `<slug>` is the first 40 characters of the task description lowercased with non-alphanumeric characters replaced by hyphens, leading/trailing hyphens stripped, and consecutive hyphens collapsed. If the slug would be empty after stripping, use `task` as the fallback. The `<id>` is the first 6 characters of the workspace's UUID. Example: "Add input validation to login form" with ID `a1b2c3d4` → `conductor/add-input-validation-to-login-form/a1b2c3`.

Before creating the worktree, validate the final branch name with `git check-ref-format --branch <name>`. If it fails, fall back to `conductor/task/<id>`.

### Workspace ID

Generated with `crypto.randomUUID()` (built into Node 20). The 6-character prefix used in branch names has a collision probability of ~1 in 16M per task — acceptable for a single-user tool.

### Cancellation

`cancelled` is a valid terminal state reachable from any non-terminal state:

- **queued** — remove from queue immediately; no worktree was created.
- **preparing** — wait for the current git command to finish (git commands are fast), then remove the worktree if it was created. This is the one case where automatic removal is permitted, since no agent work was ever done inside it.
- **running** — send an abort signal (via AbortController) to the current agent turn; wait up to 5 seconds, then stop. If the SDK does not support AbortController, the 5s wait is best-effort. Commit any changes present in the worktree, then mark cancelled. Worktree and branch are left in place.
- **awaiting_permission / awaiting_input** — resolve the pending escalation as denied, then mark cancelled.

In all cases, write a `.conductor-status` file to the worktree root with the terminal state and reason before marking the workspace terminal. This survives server restarts.

### Permission policy

**Safelist (runs silently without escalation):**
`git status`, `git diff`, `git log`, `git add`, `git commit`, `git stash`, `ls`, `cat`, `find`, `grep`, `echo`, `node` (read-only invocations), `npm test`, `npm run <script>`, `mkdir` (inside worktree only).

**Hard block list (always denied, never escalated):**
Any `rm` with `-r` or `-f` flags, `sudo`, `curl` or `wget` piped to a shell, `ssh`, `scp`, `git remote set-url`, `git config`. These are denied immediately with a log entry stating the reason.

**Escalation (everything else):** pauses the agent and asks the user with a countdown timer.

**Worktree confinement:** applies to both file-write tool calls (path must be inside the worktree) and shell commands that reference absolute paths outside the worktree. After every turn, run `git -C <worktree> status --porcelain` and verify all modified paths are inside the worktree path. If any are outside, log a critical error and mark the workspace `failed` regardless of how the escape occurred.

**Agent tools:** the agent is given access to: `read_file`, `write_file`, `list_directory`, `run_shell`. The worktree confinement check applies to `write_file`'s path argument and to any absolute path argument in `run_shell`.

### Permission timeout

The timeout for an unresolved escalation is 60 seconds, configurable via `PERMISSION_TIMEOUT_SECONDS`. When it fires, the escalation resolves as denied, the turn ends, and the workspace moves to `failed` with a log entry: `permission request timed out after Ns — task failed. Worktree is at <path> if you want to continue manually.`

Each workspace manages its own escalation independently. If two agents both hit escalations simultaneously, the console shows both side by side — approving one has no effect on the other.

### Per-turn limits

Each agent turn has a maximum wall-clock duration of `TURN_TIMEOUT_MINUTES` (default: 10). If a turn exceeds this, it is aborted and the workspace moves to `failed`.

Each workspace has a maximum total turn count of `MAX_TURNS_PER_WORKSPACE` (default: 25). When the ceiling is hit, commit any changes present, push the branch, open a draft MR, and move to `mr_open` with a log warning: `turn limit reached — work committed and pushed but task may be incomplete. Review the MR before marking ready.`

### Pipeline polling and terminal states

After a draft MR is opened, pipeline polling starts at 15-second intervals. After 5 polls with no terminal status, the interval backs off to 60 seconds and stays there. Polling uses the specific pipeline ID returned by glab at MR creation, not the branch's latest pipeline ID, to avoid tracking a wrong pipeline if a commit is pushed manually.

`mr_open` transitions:
- → `done` automatically when the pipeline reaches a passing terminal state.
- → `failed` when the pipeline fails.
- stays `mr_open` if the pipeline is cancelled in GitLab (user re-triggers there; the tool does nothing).

If the workspace is cancelled while in `mr_open`, polling stops.

### Draft MR handoff

When the MR is opened, the console displays the MR link alongside: `Draft MR opened — review and mark ready in GitLab when you're done.` Un-drafting is a deliberate manual step in GitLab.

If a MR already exists for the branch (e.g. user pushed manually), glab will error. Catch this, log it, fetch the existing MR URL via `glab mr view --web` (non-opening form), and treat it as the open MR.

### Failure modes

- **Push fails:** log the full git error, move to `failed`, write `.conductor-status`. Note the branch name so the user can push manually.
- **MR creation fails:** log the error and branch name, move to `failed` with reason `MR creation failed — branch pushed at <branch>, create MR manually.`
- **SDK error mid-turn:** log the error, commit any changes present, move to `failed`. No automatic retry.
- **Worktree creation fails:** log the exact git error, attempt cleanup of any partial directory, move to `failed`. Do not leave partial worktrees.

### Logs

Logs are scoped per workspace. Each workspace keeps the last 500 lines in memory (oldest lines dropped first — the tail is preserved). Logs are not persisted beyond the `.conductor-status` file. The console displays logs for the focused workspace lane.

### Server restart behaviour

State lives in memory. A restart loses all in-flight workspaces. On the next startup, worktrees on disk are not re-registered — they remain for manual inspection. The `.conductor-status` file written at terminal state is the only record that survives. Do not restart the server while tasks are running.

### WebSocket protocol

On initial connection and on every reconnect, the server sends a full state snapshot of all current workspaces as the first message. The console replaces its entire state from this snapshot, then applies subsequent delta events normally. Reconnect uses exponential backoff starting at 1 second, capping at 30 seconds.

**Event catalog** (defined in `types.ts`, emitted by orchestrator, relayed by server):
- `workspace_created` — new workspace added to registry
- `workspace_state_changed` — status transition, includes old and new state
- `workspace_log` — one log line for a specific workspace
- `escalation_raised` — permission request needs user decision, includes tool name and args
- `escalation_resolved` — escalation resolved (approved / denied / timed out)

## Module map

- `config.ts` — load and validate env into a typed config (absolute paths). Exposes: `REPO_PATH`, `WORKTREE_BASE_PATH`, `BASE_BRANCH`, `MAX_CONCURRENT_AGENTS`, `MAX_TURNS_PER_WORKSPACE` (default 25), `TURN_TIMEOUT_MINUTES` (default 10), `PERMISSION_TIMEOUT_SECONDS` (default 60), `ANTHROPIC_API_KEY`, `PORT` (default 4000).
- `preflight.ts` — 9 sequential startup checks; exits non-zero with a human-readable error on any failure; also runnable standalone via `npm run preflight`.
- `types.ts` — the `Workspace` shape (including `session_id?: string` and `messageHistory: Message[]` for session resume fallback), the status union, log/permission/event types, and the WebSocket event catalog.
- `util/exec.ts` — a `spawn`-based command runner that captures **both stdout and stderr**, returns `{ stdout, stderr, exitCode }`, and never throws on non-zero exit.
- `util/asyncQueue.ts` — a general-purpose push-based async iterator. Not SDK-specific; the SDK stream wiring belongs in `agent.ts`.
- `git.ts` — worktree add/remove behind an **in-process async mutex** (promise-chain lock, not a file lock); fetch (also behind the lock); diff stat; commit; push. Push does **not** require the lock — it operates on its own branch and can run concurrently. Remove is only ever called explicitly (by the user or during `preparing` cancellation), never automatically.
- `glab.ts` — open a draft MR (receives base branch and feature branch as arguments; reads no config directly), read pipeline status by pipeline ID, handle existing-MR errors. Requires glab >= 1.30.0.
- `permissions.ts` — allow / deny / escalate policy; safelist and block list as defined above; worktree-confinement check on file paths and shell command paths.
- `agent.ts` — wraps the SDK `query()` for one turn with `canUseTool` hook, AbortController for cancellation, per-turn wall-clock timeout, and session resume. First turn captures `session_id`; subsequent turns pass it back. If the SDK does not support session resume by ID, replay `messageHistory` from the Workspace instead. One `any` allowed at the SDK message/options boundary.
- `orchestrator.ts` — workspace registry; concurrency-capped dispatch queue; per-turn lifecycle including end-of-turn decision rule; escalation pause/resolve; MR handoff; event emitter. Emits the events in the catalog above.
- `server.ts` — REST routes (see below) + WebSocket relay of orchestrator events; serves `public/` as static files; binds to `127.0.0.1` only (not `0.0.0.0`). All unmatched GET routes return `public/index.html`. Calls `preflight.ts` before `listen()`.
- `public/index.html` — the console; a pure projection of server-sent state. Computes nothing independently.

### REST routes

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /workspaces | — | List all workspaces and their current state |
| POST | /workspaces | `{ description, baseBranch? }` | Create and queue a new workspace |
| POST | /workspaces/:id/cancel | — | Cancel workspace in any non-terminal state |
| POST | /workspaces/:id/escalation | `{ decision: 'approve' \| 'deny' }` | Resolve a pending permission escalation. 400 if not in `awaiting_permission` |
| POST | /workspaces/:id/followup | `{ message: string }` | Send a follow-up to an `awaiting_input` workspace. 400 if not in `awaiting_input` |

## Stack (don't substitute)

TypeScript 5.5+, NodeNext ESM (use `.js` suffixes on relative imports, no path aliases — relative imports only). Node 20+, run via `tsx` in the dev script: `tsx --conditions=node src/server.ts`. `express` for REST, `ws` for the live stream, `@anthropic-ai/claude-agent-sdk` for the agent loop (verify the exact npm package name before Phase 1 — if it differs, update `package.json` but keep all architectural assumptions). The `glab` CLI as a subprocess for GitLab (no API client, no tokens in code). The console is one vanilla HTML/CSS/JS file. No database, no UI framework, no bundler.

## Commands

- Install: `npm install`
- Typecheck (run after every file, must be clean): `npm run typecheck`
- Preflight: `npm run preflight`
- Run: `npm run dev` → http://localhost:4000

## Distribution model

This tool is single-user by design and intended to be run locally by each person who uses it. There is no shared instance, no shared account, and no shared subscription — each person brings their own GitLab credentials (via `glab`) and their own Claude subscription. Sharing means sharing the code, not a running server.

**The server binds to `127.0.0.1` (loopback only), not `0.0.0.0`. Do not port-forward or reverse-proxy it without adding authentication.**

Prerequisites for anyone running it:
- Node 20+
- `glab` CLI >= 1.30.0, installed and authenticated against their GitLab instance
- Git configured with a user identity (`user.name` and `user.email`)
- A local clone of the repo they want to work on
- A Claude subscription (ANTHROPIC_API_KEY in `.env`)

## First-run validation

`preflight.ts` runs once at startup before the server begins listening, and is also available as `npm run preflight`. All checks run sequentially, stopping at the first failure. Each failure message names the check, states what was wrong, and tells the user exactly how to fix it. No stack traces in output — those go to the log. On success: `✓ preflight passed`.

### Checks (in order)

1. **Node version** — `process.version` >= 20. Show actual vs required.
2. **`.env` / config** — all required env vars present and non-empty; path vars point to existing locations. Name the specific missing key or bad path.
3. **Git identity** — `git config user.name` and `git config user.email` non-empty in `REPO_PATH`.
4. **Repo is a git repo** — `git rev-parse --git-dir` succeeds in `REPO_PATH`.
5. **Base branch exists** — `git rev-parse --verify <BASE_BRANCH>` succeeds. (Per-task base branch is validated at task-creation time, not here.)
6. **`glab` is installed and >= 1.30.0** — `glab version` exits 0 and version is sufficient. Point to https://gitlab.com/gitlab-org/cli if not.
7. **`glab` is authenticated** — `glab auth status` exits 0. Tell user to run `glab auth login`.
8. **Claude SDK reachable** — instantiate the SDK client using `ANTHROPIC_API_KEY`. Surface the error message directly if it throws.
9. **Worktree base path is writable** — `WORKTREE_BASE_PATH` exists and is writable; create it if absent; exit with the path and problem if not writable.

## How to work

- Build in small, single-purpose modules; one responsibility per file (see the module map).
- Typecheck after each file; a red typecheck is a stop condition. `npm run typecheck` must be clean at every phase gate, not just Phase 0.
- Work through the build checklist below in order, top to bottom. Don't start a phase until the previous phase's gate is met.
- Commit the tool's own source to its git repo at the end of each phase with a plain message naming the phase (e.g. `phase 1 — primitives`).
- Prefer the simpler reading when unsure; leave a short `// NOTE:` rather than inventing structure.
- One `any` allowed: the SDK message/options boundary in `agent.ts`. Don't type the SDK message stream.
- Don't add anything not asked for. If a feature feels helpful but isn't requested, stop and ask.

## Rules that must always hold

- **Never hang.** Any decision that needs a human has a timeout that denies on expiry. Each agent turn also has a wall-clock timeout.
- **Never corrupt git.** Serialise everything that mutates the shared `.git` (worktree add/remove, fetch) behind an in-process async mutex. Work inside a worktree, and concurrent pushes to different branches, run free.
- **Never run away.** Cap concurrent agents; queue the rest. Every workspace has a turn-count ceiling and a per-turn time ceiling.
- **Never lose work.** Commit before any network step (push, MR) and before marking a running workspace as cancelled.
- **Never escape the worktree.** File writes and shell commands referencing paths outside the worktree are blocked at the permission hook. After every turn, verify via `git status` that no modified paths escaped. If any did, mark the workspace `failed`.
- **Never lie.** The console only renders state the server sends — it computes nothing on its own.
- **Never start broken.** Preflight must pass before the server accepts connections. A failed preflight is a clean exit, not a crash.

## Build checklist

### Phase 0 — scaffolding
- [ ] `package.json`, `tsconfig.json` (NodeNext, strict), `.gitignore`
- [ ] `.env.example` — every key with an inline comment and example value; path keys note they are absolute paths on the local machine; includes `ANTHROPIC_API_KEY`
- [ ] `config.ts` — typed, validated env; all keys from module map description
- [ ] `types.ts` — `Workspace` (with `session_id?: string`, `messageHistory: Message[]`, `baseBranch: string`), status union, log/permission/event types, WebSocket event catalog
- [ ] **Gate:** `npm run typecheck` is clean

### Phase 0.5 — preflight
- [ ] `preflight.ts` — all 9 checks in order; standalone runnable
- [ ] `npm run preflight` script in `package.json`
- [ ] **Gate:** running with a missing or misconfigured prerequisite prints a clear, actionable message and exits non-zero. Running with everything correct prints `✓ preflight passed`. Server wiring happens in Phase 5.

### Phase 1 — primitives
- [ ] `util/exec.ts` — captures stdout and stderr, returns `{ stdout, stderr, exitCode }`, never throws
- [ ] `util/asyncQueue.ts` — general-purpose push-based async iterator only; no SDK coupling
- [ ] `git.ts` — fetch (locked), worktree add (locked), worktree remove (locked), diff stat, commit, push (unlocked)
- [ ] `agent.ts` — one turn via SDK, `canUseTool` hook, AbortController, per-turn timeout, session resume (by ID or message history replay)
- [ ] Throwaway script in `scratch/` (gitignored); delete before the Phase 1 commit
- [ ] **Gate:** the throwaway script prints at least one tool call event to stdout before the turn completes; the target file in the worktree contains the expected edit; `session_id` is a non-empty string in the output. `npm run typecheck` clean.

### Phase 2 — orchestrator core
- [ ] `orchestrator.ts` — registry, concurrency-capped dispatch queue, per-turn lifecycle, event emitter (permissive policy, no MR yet; finished turn parks in `awaiting_input`)
- [ ] **Gate:** launch more tasks than the cap. Verify by logging events to stdout: `workspace_created` fires for each task; `workspace_state_changed` shows `queued → running` for exactly cap-count tasks; the rest stay `queued`. `npm run typecheck` clean.

### Phase 3 — permissions
- [ ] `permissions.ts` — safelist, block list, escalate; worktree-confinement check on file paths and shell command paths
- [ ] Wire escalation into orchestrator: pause → ask → resolve with fail-closed timeout
- [ ] Post-turn confinement scan via `git status`
- [ ] **Gate:** a non-safelisted command pauses the agent and shows an escalation. Approve continues; deny stops. Ignoring until timeout: workspace moves to `failed`, log contains `permission request timed out`, and the turn Promise has resolved (no hung process). An edit outside the worktree fails the post-turn scan and marks the workspace `failed`. `npm run typecheck` clean.

### Phase 4 — GitLab handoff
- [ ] `glab.ts` — open draft MR (base + feature branch as args), read pipeline status by pipeline ID, handle existing-MR error
- [ ] Orchestrator: fetch before worktree → commit remainder → push → open draft MR → poll pipeline → `mr_open` → `done` / `failed`; define all failure modes (push fail, MR fail)
- [ ] Write `.conductor-status` to worktree on terminal state
- [ ] **Gate:** a finished task becomes a draft MR on GitLab (verify in GitLab UI). Pipeline status shows `pending`/`running` if CI is configured, or `no pipeline` if not — both acceptable. `npm run typecheck` clean.

### Phase 5 — server + console
- [ ] `server.ts` — REST routes per table above; WebSocket relay; static `public/`; binds to `127.0.0.1`; calls preflight before listen
- [ ] `public/index.html` — workspace lanes; per-workspace log panel (click to focus); live permission escalation with countdown; follow-up input (visible only in `awaiting_input`, clears on state change); running indicator (elapsed time); distinct failed vs cancelled labels; draft MR link + "Mark ready in GitLab when done"; WebSocket reconnect with exponential backoff + full state snapshot on connect; no HTML `<form>`; empty state message when no workspaces exist; follow-up input shows inline error and preserves text if WebSocket is disconnected on submit
- [ ] **Gate:** (a) Submit a task — console shows `queued` before `running`. (b) Trigger an escalation — countdown timer matches server-side elapsed time within 2 seconds. (c) Disconnect and reconnect WebSocket — workspace states match `GET /workspaces` response. (d) Two agents edit a file with the same name in different worktrees — files differ on disk and neither workspace's changes appear in the other's worktree. `npm run typecheck` clean.

### Done when
- [ ] All phase gates pass and `npm run typecheck` is clean
- [ ] `npm run preflight` passes on a fresh clone with all prerequisites in place
- [ ] A second person can clone the repo, follow the README, run `npm run preflight`, and reach a working console without asking for help
- [ ] Two agents editing two branches simultaneously never touch each other's files (verified per Phase 5 gate (d))

## Don't build

File or database persistence (all state is in-memory and intentionally lost on restart), auth or multi-user, auto-merge, an in-app diff viewer, multi-repo support, agent-to-agent messaging, notifications/metrics, or any UI framework or bundler.
