npm run build

$dir = "logs"
if (!(Test-Path $dir)) {
    New-Item -ItemType Directory $dir | Out-Null
}

$time = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "$dir\$time.log"

Write-Host "Waiting for twinkle_starknightsX.exe..."

while ($true) {
    $process = Get-Process -Name "twinkle_starknightsX" -ErrorAction SilentlyContinue

    if ($process) {
        Write-Host "Game found. Starting Frida..."
        break
    }

    Start-Sleep -Seconds 5
}

frida -n twinkle_starknightsX.exe -l dist/agent.js *> $logFile