param(
  [int]$Port = 8080,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$required = @("index.html", "style.css", "app.js")
foreach ($f in $required) {
  if (-not (Test-Path $f)) { throw "Missing required file: $f" }
}

Write-Host "HackersGPT smoke check OK: $($required -join ', ')." -ForegroundColor Green
Write-Host "Serving on http://localhost:$Port" -ForegroundColor Cyan

if ($NoStart) {
  Write-Host "For local dev with /api proxy, run: node .\\dev-server.mjs" -ForegroundColor Yellow
  Write-Host "Or deploy to Vercel and test there (recommended)." -ForegroundColor Yellow
  exit 0
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  $env:PORT = $Port
  node .\dev-server.mjs
} else {
  Write-Host "Node.js not found. Deploy to Vercel to run the /api proxy." -ForegroundColor Yellow
  exit 1
}
