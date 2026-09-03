$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$pythonPath = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) {
    if ($pythonLauncher) {
        & py -3.12 -m venv .venv
        if ($LASTEXITCODE -ne 0) {
            & py -3 -m venv .venv
        }
    }
    elseif ($pythonCommand) {
        & python -m venv .venv
    }
    else {
        throw "Python 3.11 or newer is required and was not found on PATH."
    }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required. Install Node.js, then run: corepack enable"
}

& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r requirements.txt
& pnpm install --frozen-lockfile
& pnpm run build
Write-Host "SafeLink setup is complete. Authenticate with Copernicus Marine, then run .\start.ps1" -ForegroundColor Green
