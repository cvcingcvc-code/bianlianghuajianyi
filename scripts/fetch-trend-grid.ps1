$ErrorActionPreference = 'Stop'
$archiveRoot = Join-Path $PSScriptRoot '../data/market/raw/trend-grid-v1'
New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
foreach ($year in 2021..2025) {
    foreach ($month in 1..12) {
        $name = 'ETHUSDT-15m-{0}-{1:00}.zip' -f $year, $month
        $url = "https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/15m/$name"
        $zipPath = Join-Path $archiveRoot $name
        $checkPath = "$zipPath.CHECKSUM"
        if (-not (Test-Path -LiteralPath $checkPath)) {
            Invoke-WebRequest -Uri "$url.CHECKSUM" -OutFile $checkPath -UseBasicParsing -TimeoutSec 30
        }
        if (-not (Test-Path -LiteralPath $zipPath)) {
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 30
        }
        $expected = ((Get-Content -LiteralPath $checkPath -Raw).Trim() -split '\s+')[0]
        $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
        if ($expected -ne $actual) { throw "Checksum mismatch: $name" }
        Write-Output "Verified $name"
    }
}
