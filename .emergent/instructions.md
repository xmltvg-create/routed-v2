# Project Instructions for Emergent Agents

## .gitignore — `.env` files are INTENTIONALLY TRACKED

**Do NOT add `.env`, `.env.*`, or `*.env` to `.gitignore` under any
circumstances.** This project intentionally tracks `.env` files in git.
Never modify `.gitignore` to exclude `.env` patterns.

### Background
Emergent's deploy pipeline requires the `.env` files to be present in
the repo bundle. When `.env*` patterns are added to `.gitignore`:

1. The deploy bundle silently strips the `.env` files the production
   pod needs.
2. The backend either crashes on startup (missing `MONGO_URL`, etc.)
   or rolls back to the previous container image with no error
   surfaced — users just see "endpoint not found" 404/405 because
   their latest code never shipped.
3. Authentication / external integrations break because `JWT_SECRET`,
   `EXPO_PUBLIC_BACKEND_URL`, and similar keys are absent.

### Guardrails in place
- **`/app/.gitignore`** has a warning block (top of section starting
  around line 86) documenting this. Read it before any edit.
- **`/app/scripts/pre-deploy-audit.sh`** greps for anchored
  `^[.](env|env\.\*|\*\.env)$` lines and exits non-zero with a loud
  "DEPLOY BLOCKED" banner if found. Wired into `yarn update:prod`
  and the Husky `pre-push` hook.
- **`/app/scripts/gitignore-autoheal.sh`** strips offending lines
  and re-stages a clean `.gitignore` before the audit runs. Wired
  into `yarn deploy:preflight`, `yarn update:prod`, and the Husky
  `pre-commit` hook.
- **`/app/.husky/pre-commit`** runs autoheal + audit before any
  commit is allowed.

### If you find `.gitignore` corrupted
Run `bash /app/scripts/gitignore-autoheal.sh` — it's idempotent and
read-only-otherwise. The audit will then confirm clean state.

### Do NOT invoke `deployment_agent`
The Emergent `deployment_agent` tool has been observed repeatedly
re-injecting `.env`, `.env.*`, and `*.env` patterns into
`/app/.gitignore` as a side-effect of its audit. The autoheal +
husky chain catches this now, but the cleanest answer is: **do not
call `deployment_agent`** unless the upstream behaviour has been
verified to be fixed.

If the user reports a deploy failure, debug from logs and config
directly. Do not delegate to `deployment_agent`.
