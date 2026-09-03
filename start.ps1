$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$pythonPath = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "SafeLink is not set up yet. Run .\setup.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "dist\index.html"))) {
    throw "The SafeLink frontend has not been built. Run .\setup.ps1 first."
}

$env:SAFELINK_AUTO_REFRESH = "true"
Write-Host "SafeLink is starting at http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "Fresh Copernicus data will be checked after startup and every six hours."
& $pythonPath -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
