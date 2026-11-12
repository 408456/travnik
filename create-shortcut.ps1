$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Desktop = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'Travnik.lnk'
$StartFile = Join-Path $Root 'start.cmd'
$IconFile = Join-Path $Root 'app\public\link.ico'

if (-not (Test-Path -LiteralPath $StartFile)) { throw 'start.cmd was not found.' }
if (-not (Test-Path -LiteralPath $IconFile)) { throw 'Travnik icon was not found.' }

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $StartFile
$Shortcut.WorkingDirectory = $Root
$Shortcut.IconLocation = "$IconFile,0"
$Shortcut.Description = 'Travnik - transcription and phytotherapy library'
$Shortcut.WindowStyle = 7
$Shortcut.Save()

Write-Host "Desktop shortcut created: $ShortcutPath" -ForegroundColor Green
