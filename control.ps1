# FridaTest Control Panel launcher (PowerShell 5 compatible, ASCII-only to avoid encoding issues)
# Runs: npm run build -> checks deps -> launches Python control panel (waits for the game process and injects)

Set-Location $PSScriptRoot

# 1) Build latest agent.js
Write-Host "[build] Running npm run build ..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[build] FAILED, abort." -ForegroundColor Red
    pause
    exit 1
}

# 2) Check Python frida dependency. Install if missing.
try {
    python -c "import frida; import tkinter" | Out-Null
} catch {
    Write-Host "[dep] frida not found, installing frida frida-tools via pip ..." -ForegroundColor Yellow
    python -m pip install --upgrade pip
    python -m pip install frida frida-tools
}

# 3) Launch floating window
Write-Host "[run] Opening control panel (waits for the game, then auto-injects)..."
python control.py
