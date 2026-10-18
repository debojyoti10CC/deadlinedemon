# Deadline Demon

An owner-only iMessage accountability partner for any kind of work. Set one deadline or several separate task milestones, confirm them, and receive reminders. GitHub is optional: add a real PR or issue when you want independent status checks. Ordinary task completion is owner-reported and clearly labelled self-reported. Photon Spectrum Cloud carries iMessages; PostgreSQL stores commitments and durable work; OpenAI interprets free-form messages and can give recovery advice.

**Delivery status:** source and deployment tooling are provided. A successful build or mocked test is not an iPhone acceptance result. Deployment and the complete iPhone → confirmed contract → independent GitHub observation → proactive message workflow must be verified using [the acceptance checklist](docs/ACCEPTANCE.md). No public deployment or completed live acceptance is claimed here.

## Start locally

On the already configured Windows computer, double-click **START.cmd**. PostgreSQL and the required local settings have been provisioned; see [LOCAL_START.md](LOCAL_START.md) for startup, shutdown, and data locations. The following instructions cover a new checkout or another computer.

Use Node.js **22 LTS** and npm. Docker Desktop is optional for a local PostgreSQL database.

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

If `.env` already exists, keep it and edit its missing entries. Never commit it or paste its contents into chat. Obtain services one at a time:

1. **Photon:** open [the dashboard](https://app.photon.codes), select a **Stable Spectrum** project, and copy project Settings credentials into `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`. Open **Users**, add your exact iMessage sending number or email, and put that same handle in `ADMIN_IMESSAGE_HANDLE`. Shared Free/Pro routing requires that registration. [Official instructions](https://photon.codes/docs/spectrum-ts/troubleshooting/imessage). Then run `npm run connectivity`: send the unique challenge it prints to the project line. It sends one diagnostic response and stops. No OpenAI key, GitHub token, or database is needed for this check. [Photon contract details](docs/PHOTON.md).
2. **OpenAI:** create a project API key in [API settings](https://platform.openai.com/api-keys), save it as `OPENAI_API_KEY`, and set `OPENAI_MODEL` to an available Responses API model with Structured Outputs support. Keep the key on the server. The [official OpenAI quickstart](https://developers.openai.com/api/docs/quickstart) explains API keys and the SDK. This application does not silently choose a model or run paid diagnostics during install/tests.
3. **GitHub (optional):** only needed for independent PR/issue checks. Leave both GitHub settings blank to use ordinary tasks only. To enable GitHub, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to selected repositories. Use read access for Pull requests, Issues, Contents/commit statuses, and Checks where available; keep Metadata read access. Save it as `GITHUB_TOKEN`, and set `GITHUB_ALLOWED_REPOS=yourname/yourrepo` (comma-separated for more). Configure both settings together. Token permissions and organization approval determine which evidence is readable. [GitHub's token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
4. **PostgreSQL:** use the local Compose database below, or create [managed Railway PostgreSQL](https://docs.railway.com/databases/postgresql) and copy its connection URL into `DATABASE_URL`. Use the provider's TLS/connection instructions for remote databases. Set `DEFAULT_TIMEZONE` to your IANA zone, such as `Asia/Kolkata`.

Local database, bound only to this computer:

```powershell
docker compose up -d postgres
npm run preflight
npm run db:migrate
npm run build
npm start
```

The example `.env` database URL matches Compose on `127.0.0.1:5433`. `docker compose stop` preserves the database volume. While the agent is running, readiness is available at `http://127.0.0.1:3000/readyz` (also `/healthz`). Keep the process/computer running for independent reminders. Development reload: `npm run dev`. Before an upgrade, stop the old app and follow [the database migration and rollback notes](docs/MIGRATIONS.md).

## Use it in iMessage

See the [message gallery](docs/message-gallery.html) for sample formats, [format notes](docs/MESSAGE_FORMATS.md) for the presentation rules, and [proposed next changes](docs/PRODUCT_NEXT.md) for future product work. The gallery uses fictional samples and does not send messages.

Send any task and an exact future date and time in your stored timezone. For example: “Finish the front end tomorrow at 5 AM and ship tomorrow at 10 AM.” Each milestone gets a stable task number, a compact card, and its own confirmation command. Or add a real, allowed GitHub URL when you want independent PR or issue checks. Send `CONFIRM 1` to activate task #1, or select it with `first task` / `SELECT 1` and then send `CONFIRM`. A date acknowledgement such as “Yes” does not activate reminders.

Common single-task forms such as “Finish the video by tomorrow 9 AM” and “Write the draft by 19th October 9 AM” are parsed locally. A date-only answer to the immediate deadline question can complete that task. Relative dates use the stored timezone and the original message timestamp when continuing a clarification across midnight. Common spellings such as “tommorow” are accepted. Missing or ambiguous times still require clarification.

| Message | Effect |
| --- | --- |
| `SELECT 1`, `#1`, or `first task` | Select a task; bare commands then use that selection |
| `CONFIRM 1` | Activate the pending task |
| `STATUS 1` | Report task progress or refresh linked GitHub evidence |
| `PROGRESS 1 40` | Set ordinary-task HP to 40%, labelled self-reported |
| `PROGRESS 40%` | Update the selected ordinary task |
| `DONE 1` | Record ordinary-task completion as self-reported; for GitHub targets, request evidence |
| `RECHECK 1` | Refresh GitHub evidence for a linked PR or issue |
| `RESCUE 1` or “Why am I stuck?” | Request recovery advice; linked targets include GitHub evidence |
| `MOVE 1 YYYY-MM-DD HH:mm` | Change a pending draft to a future local deadline; confirmation is still required |
| `LIST` | Show task cards, HP, and recorded performance |
| `MILD`, `SAVAGE`, `NUCLEAR` or `MODE <name>` | Change the voice for current and future tasks |
| `MODE` | Preview the three intensity choices |
| `PAUSE` / `RESUME` | Pause/resume proactive monitoring and messages |
| `CANCEL 1` | Cancel that task and stop its reminders |

Task numbers remain stable after restart, completion, and cancellation. Full UUID commands still work. With multiple tasks, select one or include its number; an ineligible selection never redirects a command to a different task. Repeating an identical pending ordinary-task proposal returns the existing task. HP is the progress you report, initially 0%; it is not inferred from elapsed time. `DONE` or an explicit 100% progress report records self-reported completion and stops reminders. A passed deadline without a report means completion is unreported. For linked work, PR completion requires a non-null merge timestamp; closed unmerged PRs do not pass. Issue closure is reported as closure, not proof of shipped code. Unknown checks are never treated as green.

You can report progress or `DONE` for an ordinary draft before confirming it, including after its proposed deadline. These reports do not activate reminders; a late report is labelled late. Repeated `DONE` acknowledges the existing completion. Commands on a completed/cancelled task explain that task's state, and explicit references continue working for older history. `STATUS` shows details without changing selection. A pending GitHub draft still requires confirmation before completion checks. The [conversation and reminder audit](docs/EDGE_CASES.md) records tested edge cases and remaining live checks.

Every hour, one combined check-in shows all unfinished tasks with their current HP meters, deadlines, and draft/active/overdue labels. Drafts appear in this summary without being activated; `CONFIRM` is still required for individual deadline reminders. Completed and cancelled tasks drop out, and summaries stop when none remain. `PAUSE` silences hourly summaries too; `RESUME` allows future check-ins. The first summary is due one hour after the first task is added (or the upgrade is enabled), subject to worker/provider latency. The schedule survives restarts; downtime produces one current check-in instead of replaying each missed hour. Delivery refreshes the board and expires queued summaries after an hour. Linked GitHub work shows cached observations without a made-up HP value. Hourly summaries make no OpenAI or GitHub requests; each uses one Photon message.

Every confirmed task gets individual deadline alerts at **2 hours, 1 hour, 30 minutes, and 15 minutes remaining**, followed by a deadline check and a 15-minute follow-up if still unfinished. Only checkpoints after confirmation are scheduled. Tasks confirmed less than 15 minutes before their deadline retain a two-minute warning/follow-up, where time permits. Drafts require confirmation; completed and cancelled tasks receive no further alerts.

Each ordinary-task alert names the task and shows its current HP, exact deadline, actual time remaining, and update controls. A paused or delayed alert is checked again before delivery: expired checkpoints are skipped instead of replayed in a burst. Hourly combined check-ins remain separate. Timing depends on worker polling, provider latency, and retry backoff; PAUSE/RESUME preserves deadlines. Ordinary alerts use no OpenAI or GitHub calls, and each delivered alert uses one Photon message.

GitHub contracts also receive these checkpoints and are monitored approximately every **five minutes**. Their checkpoint alerts refresh independent evidence and use deterministic copy with actual time remaining; blocker advice, deadline verdicts, and recovery can use OpenAI. Ordinary-task reminders, status replies, and `DONE` handling remain deterministic.

## Verify without wasting quota

```powershell
npm run preflight
npm run typecheck
npm test
npm run build
```

Preflight prints configuration variable names/statuses only and makes no network calls. Unit tests isolate mocks in `tests/`; database integration tests use a separate disposable database and never point at production. Neither build nor tests call OpenAI, GitHub, or Photon.

Set `TEST_DATABASE_URL` to a separate disposable test database, then run `npm test` to include real database tests. The suite creates and removes its own uniquely named schema. Without this variable, the database tests are explicitly skipped. Current results and device checks are recorded in [implementation status](IMPLEMENTATION_STATUS.md).

Live checks are opt-in. Run only the one needed:

```powershell
npm run smoke -- --database
npm run smoke -- --github-url https://github.com/OWNER/REPO/pull/42
npm run smoke -- --openai
npm run connectivity
```

`smoke` with no flags prints help and performs no network calls. `--database` runs a read-only connectivity query. The selected PR check makes bounded GitHub reads. `--openai` makes exactly one model request with SDK retries disabled. Smoke never sends an iMessage. Connectivity sends one real diagnostic response only after the owner supplies its unique challenge. Acknowledgement is distinct from seeing the reply on your phone.

## Deploy a persistent worker

The Dockerfile builds and runs Node.js 22, including SQL migrations in the runtime image. Test `docker build -t deadline-demon .` locally if Docker is available. Add all required variables from `.env.example` to the hosting service's secret environment, using a managed PostgreSQL URL. Run a single always-on application instance initially.

For Railway, create a project with PostgreSQL, connect this repository as the application service, select this directory as its root, and use the included `railway.json`/Dockerfile. Reference the database service's `DATABASE_URL` in the app variables. The process must remain active; a scheduled/serverless invocation cannot maintain the Spectrum stream or timely workers. [Railway Dockerfile guide](https://docs.railway.com/builds/dockerfiles). After deployment, check `/readyz`, then complete the live acceptance checklist. Do not publish credentials in build arguments, source, or screenshots.

## Operations and limits

- One exact owner DM and an explicit repository allowlist are enforced. Group traffic and other senders are ignored. This application never writes GitHub code or posts to third parties.
- General free-form messages use one bounded OpenAI interpretation request. Common single-task by-deadline messages, scoped exact date replies, greetings, help, task selection, mode choices, progress, draft deadline edits, and exact controls are handled locally. Ordinary scheduled reminders, task status, and task completion use no OpenAI or GitHub calls; `RESCUE` can use one OpenAI generation request.
- PostgreSQL provides durable schedules/inbound work/outbound work, unique logical jobs, and retry records. Outbound delivery is **at least once**: a crash or timeout after Photon accepted a send can produce a duplicate on retry. The SDK exposes no stable application send key. See [Photon reliability limits](docs/PHOTON.md).
- Credentials or provider failures fail explicitly. Inspect safe application logs and failed-job records, correct the cause, and retry deliberately. GitHub rate limits defer observations; they do not prove completion.
- After five failed attempts, a record is parked. Correct the integration, then run `npx tsx scripts/retry-failed.ts --retry` to requeue failed work. This may consume service quota. Missed-contract monitoring stops after 24 hours; owner-triggered proof checks remain available.
- Conversation and evidence data are stored in PostgreSQL, and relevant context is sent to OpenAI. Restrict database access and back up before destructive maintenance. To remove owner data, stop the app and run `npx tsx scripts/delete-data.ts --confirm-delete-owner`; this permanently removes the configured owner's contracts/history/jobs together. Deletion does not revoke external credentials.
- No dashboard, iOS app, automatic GitHub writes, or fake chat simulator is included. Deployment access, paid-service billing, real device receipt, and the full competition demo require live verification.

See [acceptance](docs/ACCEPTANCE.md) for evidence to collect and [Photon integration](docs/PHOTON.md) for authorization, routing, timeouts, and retry boundaries.
