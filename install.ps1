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
#   $env:RYU_SKIP_CHECKSUM  1 to skip sha256 verify   (default: verify, abort on failure)

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

Write-Host "Installing Ryu ($suffix) into $installDir"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

foreach ($bin in $binaries) {
  $asset = "$bin-$suffix.exe"
  $url   = "$base/$asset"
  $out   = Join-Path $installDir "$bin.exe"
  Write-Host "  $bin"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing

  # Checksum verification — fail closed. Releases publish a .sha256 next to
  # every binary, so a missing/failed checksum download aborts the install
  # instead of silently skipping verification. Emergency escape hatch:
  # $env:RYU_SKIP_CHECKSUM = '1'.
  if ($env:RYU_SKIP_CHECKSUM -eq '1') {
    Write-Host '  RYU_SKIP_CHECKSUM=1 — skipping checksum verification (not recommended)'
  } else {
    try {
      $shaContent = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content
    } catch {
      throw "could not download checksum $url.sha256 — refusing to install an unverified binary (set `$env:RYU_SKIP_CHECKSUM = '1' to bypass): $_"
    }
    if ($shaContent -is [byte[]]) { $shaContent = [System.Text.Encoding]::ASCII.GetString($shaContent) }
    $want = ([string]$shaContent -split '\s+')[0].Trim()
    if ($want -notmatch '^[0-9a-fA-F]{64}$') {
      throw "malformed checksum file at $url.sha256 — refusing to install (set `$env:RYU_SKIP_CHECKSUM = '1' to bypass)"
    }
    $got = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
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
