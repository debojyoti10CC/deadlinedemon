param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pgCtl = Join-Path $projectRoot 'work\postgres-runtime\pgsql\bin\pg_ctl.exe'
$dataDirectory = Join-Path $projectRoot 'work\local-db\data'
$logFile = Join-Path $projectRoot 'work\local-db\postgres.log'

if (-not (Test-Path -LiteralPath $pgCtl) -or -not (Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION'))) {
    throw 'This computer has no provisioned portable database. Use the Docker Compose setup in README.md.'
}

& $pgCtl status -D $dataDirectory *> $null
$running = $LASTEXITCODE -eq 0

switch ($Action) {
    'Start' {
        if ($running) { Write-Output 'Local PostgreSQL is already running.' }
        else {
            & $pgCtl start -D $dataDirectory -l $logFile -w -t 30
            if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL failed to start. Check work/local-db/postgres.log.' }
        }
    }
    'Stop' {
        if (-not $running) { Write-Output 'Local PostgreSQL is already stopped.' }
        else {
            & $pgCtl stop -D $dataDirectory -m fast -w -t 30
            if ($LASTEXITCODE -ne 0) { throw 'Local PostgreSQL failed to stop.' }
        }
    }
    'Status' {
        if ($running) { Write-Output 'Local PostgreSQL is running on 127.0.0.1:5433.' }
        else { Write-Output 'Local PostgreSQL is stopped.' }
    }
}
