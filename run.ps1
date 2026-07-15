npm run build
$dir = "logs"

if (!(Test-Path $dir)) {
    New-Item -ItemType Directory $dir | Out-Null
}

$time = Get-Date -Format "yyyyMMdd_HHmmss"

frida -n twinkle_starknightsX.exe `
    -l dist/agent.js `
    *> "$dir\$time.log"