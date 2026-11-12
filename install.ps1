$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root 'tools'
$Models = Join-Path $Root 'models'
$Downloads = Join-Path $Tools '_downloads'

New-Item -ItemType Directory -Force -Path $Tools, $Models, $Downloads | Out-Null

function Download-Atomic {
    param([string]$Url, [string]$Destination, [int64]$MinimumBytes = 1024)
    if ((Test-Path -LiteralPath $Destination) -and ((Get-Item -LiteralPath $Destination).Length -ge $MinimumBytes)) {
        Write-Host "Already downloaded: $([IO.Path]::GetFileName($Destination))"
        return
    }
    $Part = "$Destination.part"
    Write-Host "Downloading: $([IO.Path]::GetFileName($Destination))"
    if (Test-Path -LiteralPath $Part) { Remove-Item -LiteralPath $Part -Force }
    try {
        if ($Url.StartsWith('https://huggingface.co/')) {
            curl.exe -L --fail --ssl-no-revoke --retry 5 --retry-delay 3 --output $Part $Url
            if ($LASTEXITCODE -ne 0) { throw "curl failed with code $LASTEXITCODE" }
        } else {
            Import-Module BitsTransfer -ErrorAction Stop
            Start-BitsTransfer -Source $Url -Destination $Part -DisplayName 'Travnik setup' -Description $Destination -ErrorAction Stop
        }
    } catch {
        Write-Warning 'Primary download method failed; trying curl.'
        curl.exe -L --fail --ssl-no-revoke --retry 5 --retry-delay 3 --output $Part $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
    if ((Get-Item -LiteralPath $Part).Length -lt $MinimumBytes) { throw "Downloaded file is too small: $Part" }
    Move-Item -LiteralPath $Part -Destination $Destination -Force
}

Write-Host '1/5 - Node.js'
$PortableNode = Join-Path $Tools 'node\node.exe'
$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($SystemNode) {
    $NodeExe = $SystemNode.Source
    Write-Host "Using installed Node.js: $NodeExe"
} elseif (-not (Test-Path -LiteralPath $PortableNode)) {
    $NodeZip = Join-Path $Downloads 'node-v24.14.1-win-x64.zip'
    Download-Atomic 'https://nodejs.org/dist/v24.14.1/node-v24.14.1-win-x64.zip' $NodeZip 20000000
    $NodeExtract = Join-Path $Downloads 'node-extract'
    if (Test-Path -LiteralPath $NodeExtract) { Remove-Item -LiteralPath $NodeExtract -Recurse -Force }
    Expand-Archive -LiteralPath $NodeZip -DestinationPath $NodeExtract -Force
    $NodeFolder = Get-ChildItem -LiteralPath $NodeExtract -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PortableNode) | Out-Null
    Copy-Item -LiteralPath (Join-Path $NodeFolder.FullName 'node.exe') -Destination $PortableNode -Force
    $NodeExe = $PortableNode
} else {
    $NodeExe = $PortableNode
}

Write-Host '2/5 - yt-dlp'
$YtDlp = Join-Path $Tools 'yt-dlp.exe'
Download-Atomic 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $YtDlp 10000000

Write-Host '3/5 - whisper.cpp'
$WhisperExe = Join-Path $Tools 'whisper\whisper-cli.exe'
if (-not (Test-Path -LiteralPath $WhisperExe)) {
    $WhisperZip = Join-Path $Downloads 'whisper-bin-x64-b5454.zip'
    Download-Atomic 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' $WhisperZip 1000000
    $ActualHash = (Get-FileHash -LiteralPath $WhisperZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $ExpectedHash = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
    if ($ActualHash -ne $ExpectedHash) { throw 'whisper.cpp checksum mismatch. Installation stopped.' }
    $WhisperExtract = Join-Path $Downloads 'whisper-extract'
    if (Test-Path -LiteralPath $WhisperExtract) { Remove-Item -LiteralPath $WhisperExtract -Recurse -Force }
    Expand-Archive -LiteralPath $WhisperZip -DestinationPath $WhisperExtract -Force
    $Release = Get-ChildItem -LiteralPath $WhisperExtract -Directory -Recurse | Where-Object { Test-Path (Join-Path $_.FullName 'whisper-cli.exe') } | Select-Object -First 1
    if (-not $Release) { throw 'whisper-cli.exe was not found in the downloaded archive.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WhisperExe) | Out-Null
    Copy-Item -Path (Join-Path $Release.FullName '*') -Destination (Split-Path -Parent $WhisperExe) -Recurse -Force
}

Write-Host '4/5 - Russian speech model (about 190 MB)'
$Model = Join-Path $Models 'ggml-small-q5_1.bin'
Download-Atomic 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin' $Model 180000000
$ActualModelHash = (Get-FileHash -LiteralPath $Model -Algorithm SHA256).Hash.ToLowerInvariant()
$ExpectedModelHash = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
if ($ActualModelHash -ne $ExpectedModelHash) { throw 'Whisper model checksum mismatch. Installation stopped.' }

Write-Host '5/5 - FFmpeg'
$Ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
$LocalFfmpeg = Join-Path $Tools 'ffmpeg\ffmpeg.exe'
if ((-not $Ffmpeg) -and (-not (Test-Path -LiteralPath $LocalFfmpeg))) {
    $FfmpegZip = Join-Path $Downloads 'ffmpeg-release-essentials.zip'
    Download-Atomic 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $FfmpegZip 50000000
    $FfmpegExtract = Join-Path $Downloads 'ffmpeg-extract'
    if (Test-Path -LiteralPath $FfmpegExtract) { Remove-Item -LiteralPath $FfmpegExtract -Recurse -Force }
    Expand-Archive -LiteralPath $FfmpegZip -DestinationPath $FfmpegExtract -Force
    $FfmpegBin = Get-ChildItem -LiteralPath $FfmpegExtract -Directory -Recurse | Where-Object { Test-Path (Join-Path $_.FullName 'ffmpeg.exe') } | Select-Object -First 1
    if (-not $FfmpegBin) { throw 'ffmpeg.exe was not found in the downloaded archive.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LocalFfmpeg) | Out-Null
    Copy-Item -Path (Join-Path $FfmpegBin.FullName '*') -Destination (Split-Path -Parent $LocalFfmpeg) -Force
}

& $NodeExe --disable-warning=ExperimentalWarning (Join-Path $Root 'app\server.mjs') --doctor
if ($LASTEXITCODE -ne 0) { throw 'Installation check failed.' }

& (Join-Path $Root 'create-shortcut.ps1')

Write-Host ''
Write-Host 'Travnik installation completed.' -ForegroundColor Green
