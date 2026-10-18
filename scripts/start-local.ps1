$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $projectRoot
try {
    & (Join-Path $PSScriptRoot 'local-db.ps1') -Action Start
    foreach ($step in @('preflight', 'db:migrate', 'build')) {
        & npm.cmd run $step
        if ($LASTEXITCODE -ne 0) { throw "Startup step failed: $step" }
    }
    Write-Output 'Starting Deadline Demon. Keep this window open; press Ctrl+C to stop the agent.'
    & node.exe dist/src/index.js
    if ($LASTEXITCODE -ne 0) { throw 'Deadline Demon exited with an error. Review the application output above.' }
}
finally { Pop-Location }
