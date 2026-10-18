# Run Deadline Demon on this computer

PostgreSQL 17.11 is provisioned locally, its migrations are applied, and `.env` contains the connection string. The application role is not a PostgreSQL administrator. A separate `deadline_demon_test` database is available for automated tests.

Double-click **START.cmd**, or run:

```powershell
.\START.cmd
```

The launcher starts the database, validates configuration, applies migrations, builds the application, and starts the real Photon consumer and workers. Keep the terminal and computer running. Press **Ctrl+C** to stop the agent. The health endpoint is [http://127.0.0.1:3000/readyz](http://127.0.0.1:3000/readyz).

The launcher does not run paid diagnostics. GitHub is optional. Use the stable numbers shown on the board: `LIST`, `SELECT 1`, `CONFIRM 1`, `STATUS 1`, `PROGRESS 1 40`, `DONE 1`, and `CANCEL 1`. `first task` selects the first current task, and a bare `CONFIRM` then uses that selection. `MILD`, `SAVAGE`, or `NUCLEAR` changes the voice for current and new tasks. Move an expired pending draft with `MOVE 1 YYYY-MM-DD HH:mm` using a future local time. These controls, ordinary reminders, and HP reports need no OpenAI or GitHub request. Free-form messages use OpenAI for interpretation; `RESCUE 1` can use one generation request.

The first device check passed on 2026-10-18: the owner confirmed receiving the **LIST** reply on the real iPhone. To repeat this check, send **LIST** from the registered owner phone to the serving line displayed in your Photon dashboard. This command needs no OpenAI or GitHub request. The complete contract/reminder/merge workflow remains a separate acceptance gate.

Database controls, after stopping the agent:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-db.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-db.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-db.ps1 -Action Start
```

Stopping either process preserves contracts. Database files and local credentials are in the ignored `work/local-db` directory; do not delete it to clear logs or package it for sharing. The portable server binaries are in ignored `work/postgres-runtime`. Neither directory is committed. The normal Docker/managed-host instructions in README.md apply on another computer.

This local installation depends on this computer remaining awake. A cloud deployment and real iPhone acceptance are separate release gates; see docs/ACCEPTANCE.md.

Runtime provenance: the PostgreSQL Windows archive was obtained from [EDB's official distribution](https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip). Its SHA-256 matched the [publisher's checksum](https://github.com/EnterpriseDB/edb-installers/issues/682): `4b8db0930c38f6ef845db919551dedda3b6b845aeb0927b3d79a6e8e9e4537cf`.
