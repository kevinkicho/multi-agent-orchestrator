# Contributing

Thanks for your interest in contributing. This project is built on [Bun](https://bun.sh) and TypeScript. You'll need Bun installed locally.

## Setup

1. **Install Bun** — see https://bun.sh for install instructions.
2. **Fork & clone** the repo and create a feature branch off `main`:
   ```
   git checkout -b feat/my-change
   ```
3. **Install dependencies**:
   ```
   bun install
   ```
4. **Verify the checkout is healthy** before changing anything:
   ```
   bun run typecheck
   bun test
   ```

## Running the project

- `bun run dev` — launch the CLI (`src/cli.ts`)
- `bun run start` — launch the orchestrator (`src/launcher.ts`)
- `bun run smoke` — end-to-end smoke test

## Checks before committing

There is no linter on this project. Before opening a PR, make sure:

- `bun run typecheck` passes (no TypeScript errors).
- `bun test` passes (tests live in `src/tests/` and `src/__tests__/`).
- `bun run check-secrets` passes (no credentials in the diff).

CI runs `bun install`, `bun run typecheck`, and `bun test` on every push and pull request — the same three commands above.

## Commit style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): ...` for new features
- `fix(scope): ...` for bug fixes
- `chore: ...` / `ci: ...` / `test: ...` / `docs: ...` for other work

Keep commits focused — one logical change per commit. Avoid bundling unrelated edits.

## Pull requests

1. Push your branch and open a PR against `main`.
2. Summarize the change and the motivation. Link any related issue.
3. Note how you tested the change (commands run, scenarios covered).
4. Keep PRs small where reasonable — easier to review, easier to revert.

## Ground rules

- Never commit secrets, API keys, or credentials. The `.gitignore` already covers the common runtime artifact files, but double-check your diff.
- Match the style of the surrounding code when in doubt.
- New behavior should come with tests where practical.
