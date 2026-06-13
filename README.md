# ducl

ducl runs multiple Claude Code sessions in parallel, each on its own git branch, and opens a GitLab MR when each session ends.

## Prerequisites

- Node.js 20+
- git
- [glab](https://gitlab.com/gitlab-org/cli) ≥ 1.30.0, authenticated (`glab auth login`)
- [Claude Code](https://claude.ai/download) installed and logged in

## Setup (Windows)

Prerequisites:
- Node.js 20+ ([nodejs.org](https://nodejs.org))
- Claude Code installed and logged in (`claude` command available in terminal)
- glab CLI ([gitlab.com/gitlab-org/cli](https://gitlab.com/gitlab-org/cli)), then `glab auth login`

```sh
git clone <this-repo> conductor
cd conductor
cp .env.example .env          # then edit .env
npm install
npm run preflight             # verifies all prerequisites
npm run electron              # first launch shows the setup screen
```

Configure repo path (e.g. `C:\Users\yourname\my-repo`) and worktree base path (e.g. `C:\Users\yourname\conductor-worktrees`) in the setup screen.

To build a distributable installer: `npm run dist:win` — output in `release/`

## Setup (Mac)

Prerequisites:
- Node 20+ (`brew install node`)
- Claude Code installed and logged in (`claude` command available in terminal)
- glab CLI (`brew install glab`, then `glab auth login`)

```sh
git clone <this-repo> conductor
cd conductor
cp .env.example .env          # then edit .env
npm install
npm run preflight             # verify claude and glab are detected
npm run electron              # first launch shows the setup screen
```

Configure repo path (e.g. `/Users/yourname/my-repo`) and worktree base path (e.g. `/Users/yourname/conductor-worktrees`) in the setup screen.

To build a distributable `.dmg`: `npm run dist:mac` — output in `release/`

## Setup (headless / dev server only)

Edit `.env` and set:
- `REPO_PATH` — absolute path to the git repo you want to work in
- `WORKTREE_BASE_PATH` — where ducl creates worktrees (created automatically if absent)
- `BASE_BRANCH` — branch new sessions are cut from (e.g. `main`)

## Running

```sh
npm run dev
```

Open **http://localhost:4000**

## Creating a session

1. Describe your task in the composer at the bottom
2. Set the base branch (defaults to `BASE_BRANCH`)
3. Pick a model and click **Start →**

Claude Code opens in the browser. Work normally in the terminal. When you exit Claude Code (`/exit` or Ctrl+C), ducl automatically pushes the branch and opens a draft MR on GitLab.

## Parallel sessions

You can run up to `MAX_CONCURRENT_AGENTS` sessions simultaneously (default: 3). Additional tasks are queued and start automatically when a slot frees.

Click **New task** in the sidebar while a session is running to queue another one.

## Per-repo config

```sh
cp .conductor/settings.json.example .conductor/settings.json
```

Edit `.conductor/settings.json` to set:
- `defaultModel` — pre-selects the model in the composer
- `defaultBaseBranch` — pre-fills the branch input
- `branchPresets` — type `feature` in the branch input to resolve to `develop`, etc.
- `maxConcurrentAgents` — override the env var

## Troubleshooting

`npm run preflight` tells you exactly what's wrong.

| Issue | Fix |
|---|---|
| `REPO_PATH does not exist` | Point `REPO_PATH` in `.env` to an existing git repo |
| `glab is not authenticated` | Run `glab auth login` |
| `claude CLI not found` | Install Claude Code or set `CLAUDE_BIN=/path/to/claude` in `.env` |
| `BASE_BRANCH does not exist` | Set `BASE_BRANCH` to a branch that exists in the repo |
| Terminal renders narrow columns | Resize the browser window; the terminal auto-fits |
