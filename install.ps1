# Ryu one-line installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex
#
# Downloads the headless stack — ryu-core, ryu-gateway, ryu-cli — into
# %USERPROFILE%\.ryu\bin and adds it to your user PATH. Core starts the Gateway
# and a fully-local model stack itself, so there is nothing else to wire up.
#
# Environment overrides:
#   $env:RYU_INSTALL_DIR    install location   (default: $HOME\.ryu\bin)
#   $env:RYU_VERSION        release tag e.g. v0.0.4   (default: latest)
#   $env:RYU_SKIP_CHECKSUM  1 to skip sha256 verify   (default: verify when available)

$ErrorActionPreference = 'Stop'

$repo       = 'amajorai/ryu'
$installDir = if ($env:RYU_INSTALL_DIR) { $env:RYU_INSTALL_DIR } else { Join-Path $HOME '.ryu\bin' }
$binaries   = @('ryu-core', 'ryu-gateway', 'ryu-cli')

# --- detect arch ------------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
  throw "Windows $arch is not supported by the prebuilt binaries (only x86_64/AMD64). Build from source: https://github.com/$repo#quick-start-self-host"
}
$suffix = 'windows-x86_64'

$base = if ($env:RYU_VERSION) {
  "https://github.com/$repo/releases/download/$($env:RYU_VERSION)"
} else {
  "https://github.com/$repo/releases/latest/download"
}

function Test-Url([string]$url) {
  try { Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing | Out-Null; return $true }
  catch { return $false }
}

Write-Host "Installing Ryu ($suffix) into $installDir"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

foreach ($bin in $binaries) {
  $asset = "$bin-$suffix.exe"
  $url   = "$base/$asset"
  $out   = Join-Path $installDir "$bin.exe"
  Write-Host "  $bin"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing

  # checksum (best-effort; the binaries job may not publish .sha256)
  if ($env:RYU_SKIP_CHECKSUM -ne '1' -and (Test-Url "$url.sha256")) {
    $want = ((Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content -split '\s+')[0].Trim()
    $got  = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
    if ($want.ToLower() -ne $got) { throw "checksum mismatch for $asset (want $want, got $got)" }
  }
}

# --- PATH (user scope) ------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host "Added $installDir to your user PATH — open a new terminal to pick it up."
}

Write-Host ''
Write-Host "Done. Installed: $($binaries -join ', ')"
Write-Host ''
Write-Host 'Next:'
Write-Host '  ryu-core     # start the node (spawns the Gateway + a local model stack, no key needed)'
Write-Host '  ryu-cli      # in another terminal, connect the TUI to it'
Write-Host ''
Write-Host 'Point any OpenAI-compatible client at the Gateway: http://127.0.0.1:7981/v1'
