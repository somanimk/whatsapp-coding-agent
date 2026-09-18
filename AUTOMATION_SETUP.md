# Coding workflow setup (after the working Phase 1 webhook)

This implementation is opt-in. Keep `AUTOMATION_ENABLED=false` until setup is complete. The deployed Phase 1 webhook keeps working without database/GitHub/OpenAI configuration. No external coding run or merge has been performed while implementing this phase.

## Architecture

Meta webhook → signed POST → allowed sender → PostgreSQL inbox/task/outbox → GitHub Actions worker → replaceable coding adapter → isolated validation → new task branch/PR → GitHub deployment status from Vercel → WhatsApp preview → explicit APPROVE → verified head/checks → merge.

The initial `OpenAIFileAgent` uses the Responses API with structured output. It proposes complete text file edits and never receives GitHub/WhatsApp/database credentials or shell tools. Replace the `CodingAgent` implementation to upgrade it. This is not a connection to the local Codex desktop chat. You need a separately billed OpenAI API key and a compatible model set in `OPENAI_MODEL`.

Modules are in `lib/automation/`: config, policy, store, inbox, agent, workspace, github, publish. `scripts/worker.ts` orchestrates the pipeline. `scripts/schema.sql` defines durable tables. `.github/workflows/coding-worker.yml` runs the worker every five minutes and can be dispatched after messages. Schedules can be delayed by GitHub; they are not real-time guarantees. A task can take several minutes.

## 1. Add PostgreSQL storage

Create a PostgreSQL database, for example through Vercel's Storage Marketplace (Neon), and obtain its TLS connection URL. Keep the URL private. Add `DATABASE_URL` to the WhatsApp Vercel project's Production environment and the service repository's GitHub Actions secrets.

Apply the schema using the database provider's SQL editor (paste `scripts/schema.sql`) or configure the environment locally and run:

```sh
npm run db:migrate
```

When running locally, Node does not automatically load `.env.local` for these standalone scripts. With Node 22.13+ you can use:

```sh
node --env-file=.env.local --conditions=react-server --import tsx scripts/migrate.ts
```

Tables store message IDs, sender numbers, instructions, PR metadata, reviewed commit SHA, approvals, and pending notifications. Protect database and log access.

## 2. Configure GitHub access

Create a fine-grained GitHub personal access token for `somanimk` with access to:

- `Mayank-Portfolio-Site`: Contents read/write, Pull requests read/write, Deployments read, Checks read, Commit statuses read.
- `whatsapp-coding-agent`: Actions read/write for workflow dispatch.

GitHub may apply permissions at the token level across the selected repositories. Store the token as `GITHUB_AUTOMATION_TOKEN` in Vercel and the worker's GitHub Actions secrets. Never commit it. The publisher is fixed to `somanimk/Mayank-Portfolio-Site` and only creates refs under `whatsapp/task-<task-id>`. It discovers the target default branch (currently master) and never pushes to main/master/default branches. Merge is a separate API operation gated by explicit approval.

Protect the portfolio's default branch in GitHub and require its appropriate checks. Ensure squash merges are enabled. Vercel must remain connected to the portfolio repository and create preview deployments for task branches/PRs. Preview lookup uses GitHub deployment records for the exact commit, with Preview environment and a successful HTTPS `.vercel.app` URL. If your Vercel integration does not publish those records, the task stays awaiting_preview; inspect the GitHub deployment integration before approving.

## 3. Configure the service

Add these variables to Vercel Production, in addition to the five working WhatsApp variables:

```env
AUTOMATION_ENABLED=false
WHATSAPP_ALLOWED_SENDERS=YOUR_PERSONAL_NUMBER_IN_INTERNATIONAL_DIGITS
DATABASE_URL=YOUR_PRIVATE_DATABASE_URL
GITHUB_AUTOMATION_TOKEN=YOUR_PRIVATE_GITHUB_TOKEN
GITHUB_WORKER_REPO=somanimk/whatsapp-coding-agent
GITHUB_WORKER_REF=phase1-webhook
```

Use international digits without `+` or spaces. Only those allowed numbers can create tasks, ask for status, approve, or reject. Other senders are acknowledged to Meta but ignored. Each task belongs to its original sender. Do not enable automation without setting an explicit allowlist.

## 4. Configure GitHub Actions

In `whatsapp-coding-agent` → Settings → Secrets and variables → Actions, add **repository secrets**:

```text
DATABASE_URL
GITHUB_AUTOMATION_TOKEN
OPENAI_API_KEY
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
```

Add **repository variables**:

```text
AUTOMATION_ENABLED=false
OPENAI_MODEL=<a Responses API model supporting structured outputs>
WHATSAPP_API_VERSION=v25.0
```

Use the same database and WhatsApp token/number as Vercel. Secrets are injected as worker environment variables. `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` are only needed by Vercel's inbound webhook, not by the worker.

The workflow must be reviewed and merged into the service's default branch before its schedule/dispatch can work. Keep `GITHUB_WORKER_REF` set to that reviewed default branch; currently `phase1-webhook`. This implementation is developed on a separate feature branch. Do not point a privileged worker at agent-controlled target PR code. The workflow checks out the trusted service code with credential persistence disabled; candidate portfolio code is executed only inside Docker.

## 5. Enable and test

1. Review/merge the service implementation PR into the service default branch. This is setup, not an automated portfolio task approval.
2. Confirm schema and all worker secrets/variables are present. Set the GitHub Actions repository variable `AUTOMATION_ENABLED=true`. Manually run the `WhatsApp coding worker` workflow once to check connectivity. It should find no tasks if automation is still disabled.
3. Set `AUTOMATION_ENABLED=true` in Vercel and redeploy.
4. Send one small task, such as `Adjust the hero greeting spacing on mobile.`
5. Receive the queued task ID, then PR summary and preview link. The worker checks lint and build before publishing. Review the PR diff and preview yourself.
6. Reply `APPROVE <exact-task-id>` from the original allowed number. The worker checks that the reviewed SHA and base are unchanged, that checks succeed, and that the PR is mergeable before requesting a squash merge with the exact approved head SHA.
7. Verify the merge confirmation and portfolio deployment. If the head/base changed, the task fails closed; submit a new task for a new preview instead of reusing approval.

`STATUS <task-id>` returns the current state and links. `REJECT <task-id>` prevents a queued/awaiting-preview/ready task from merging. An approval already recorded is a merge authorization; rejection is refused after approval or during running work. Rejection keeps the branch/PR for review rather than deleting them. Plain coding messages always create separate task IDs/branches; retrying the same signed message ID does not create another task.

## Limits and recovery

- The adapter supports small text edits under app/, components/, and lib/ only, up to 20 files/250 KB. No package/dependency changes, binary images, secrets, workflow changes, or deployment config changes. Context is capped at 100 files/180,000 characters. Unsupported requests fail rather than silently broadening permissions.
- The current workspace adapter supports the public portfolio repository. A private target needs a separate read-only checkout mechanism.
- Candidate code runs inside a credential-free Docker container with resource limits. This protects service credentials but is not a promise that generated code is safe; PR/preview review remains necessary. No visual/browser QA is automated yet.
- One new coding task is generated per worker run. GitHub Actions has a 25-minute job limit, each validator a 10-minute limit. Crashed running jobs are marked failed after 30 minutes. A PR/branch created before a database failure can remain orphaned and must be reviewed manually; no automatic merge occurs.
- Outbox sends retry up to five times. WhatsApp's customer-service window applies; a delayed notification outside it can fail and needs an approved template in a future phase. There is a small send/database crash window where a notification may be repeated, since WhatsApp sends are not transactionally tied to PostgreSQL. Coding task creation and approvals are durably deduplicated.
- PostgreSQL and model/GitHub service failures are visible in logs without logging credentials/provider response bodies. A storage failure returns 503 so Meta retries; a dispatch failure leaves a durable task for the scheduled worker.
- Pause both the Vercel environment flag and GitHub Actions `AUTOMATION_ENABLED` variable to pause automation intake and processing.
- The worker never enables GitHub auto-merge. Every merge requires the stored explicit approval for that task/head. GitHub branch protection should be your additional server-side enforcement.

References: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GitHub PR merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [GitHub deployments](https://docs.github.com/en/rest/deployments/deployments).

## Use Gemini instead of OpenAI

In GitHub Settings → Secrets and variables → Actions, add repository secret
`GEMINI_API_KEY` and repository variables `CODING_PROVIDER=gemini` and
`GEMINI_MODEL=<your available model ID supporting structured outputs>`.
OpenAI credentials are not required when selecting Gemini. No Gemini key is
needed in Vercel: only the trusted GitHub worker calls the model.
Keep AUTOMATION_ENABLED=false in both places until all setup is complete.
Deploy the updated service workflow before running a task. Free-tier quotas
can limit requests; model availability and free eligibility depend on the account.
The adapter rejects blocked or truncated responses and validates every edit
using the same path restrictions as OpenAI. It never falls back to a paid provider.
Reference: https://ai.google.dev/api/generate-content
