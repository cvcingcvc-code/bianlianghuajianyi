$ErrorActionPreference = 'Stop'
$archiveRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../data/eth-v2/raw'))
New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
$jobs = foreach ($year in 2021..2025) { foreach ($month in 1..12) {
    $name = 'ETHUSDT-fundingRate-{0}-{1:00}.zip' -f $year, $month
    @{ Name = $name; URL = "https://data.binance.vision/data/futures/um/monthly/fundingRate/ETHUSDT/$name" }
    if ($year -ge 2023) {
        $name = 'ETHUSDT-1m-{0}-{1:00}.zip' -f $year, $month
        @{ Name = "mark-$name"; URL = "https://data.binance.vision/data/futures/um/monthly/markPriceKlines/ETHUSDT/1m/$name" }
    }
} }
$jobs | ForEach-Object -Parallel {
    $ErrorActionPreference = 'Stop'
    $target = Join-Path $using:archiveRoot $_.Name
    foreach ($suffix in @('.CHECKSUM', '')) {
        $destination = "$target$suffix"
        if (-not (Test-Path -LiteralPath $destination)) {
            $tempFile = "$destination.partial"
            Invoke-WebRequest -Uri "$($_.URL)$suffix" -OutFile $tempFile -TimeoutSec 60
            Move-Item -LiteralPath $tempFile -Destination $destination
        }
    }
    $expected = ((Get-Content -LiteralPath "$target.CHECKSUM" -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch: $target" }
    Write-Output "Verified $($_.Name)"
} -ThrottleLimit 6
if ($Error.Count) { exit 1 }
