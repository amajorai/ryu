# Ryu one-line installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex
#
# Installs and starts the headless stack — ryu-core, ryu-gateway, ryu-cli — in
# %USERPROFILE%\.ryu\bin. Starting Core is part of the install so the same entry
# point also kicks off the bundled models, engines, skills, and built-in defaults.
# Core owns those defaults. Shadow and Ghost are preinstalled and started by Core.
# Island is preinstalled and kept up to date through the global download center,
# but remains stopped until the companion feature is enabled in a later release.
#
# Environment overrides:
#   $env:RYU_INSTALL_DIR    install location   (default: $HOME\.ryu\bin)
#   $env:RYU_VERSION        release tag e.g. v0.0.4   (default: latest)
#   $env:RYU_SKIP_CHECKSUM  1 to skip sha256 verify   (default: verify, abort on failure)
#   $env:RYU_START_CORE     0 to install without starting Core (default: 1)
#   $env:RYU_CORE_BIND      Core bind address (default: 127.0.0.1:7980)
#   $env:RYU_CORE_URL       Core health URL (default: http://127.0.0.1:7980)
#   $env:RYU_PROGRESS_FORMAT json to emit RYU_INSTALL_EVENT JSON lines
#   $env:RYU_INSTALL_MARKER  version marker written beside installed binaries
#                            (default: $env:RYU_VERSION; an unpinned install always reinstalls)
#   $env:RYU_FORCE_INSTALL   1 to reinstall even when the marker already matches
# Desktop supplies -ReleaseBase from its packaged distribution configuration.

param([string]$ReleaseBase = 'https://github.com/amajorai/ryu/releases')

$ErrorActionPreference = 'Stop'

$releaseUri = $null
if (-not [Uri]::TryCreate($ReleaseBase, [UriKind]::Absolute, [ref]$releaseUri) -or
    $releaseUri.Scheme -ne 'https' -or [string]::IsNullOrEmpty($releaseUri.Host) -or
    -not $ReleaseBase.StartsWith('https://', [StringComparison]::Ordinal) -or
    -not [string]::IsNullOrEmpty($releaseUri.UserInfo) -or
    -not [string]::IsNullOrEmpty($releaseUri.Query) -or
    -not [string]::IsNullOrEmpty($releaseUri.Fragment) -or
    $ReleaseBase.Trim() -ne $ReleaseBase -or $ReleaseBase.Contains('\') -or
    $ReleaseBase -match '[\x00-\x1f\x7f]' -or
    ($ReleaseBase -split '://', 2)[1].Split('/')[0].Contains('@')) {
  throw 'ReleaseBase must be HTTPS without credentials, query, or fragment'
}
$ReleaseBase = $releaseUri.AbsoluteUri.TrimEnd('/')

$repo       = 'amajorai/ryu'
$installDir = if ($env:RYU_INSTALL_DIR) { $env:RYU_INSTALL_DIR } else { Join-Path $HOME '.ryu\bin' }
$binaries   = @('ryu-core', 'ryu-gateway', 'ryu-cli')
$progressFormat = if ($env:RYU_PROGRESS_FORMAT) { $env:RYU_PROGRESS_FORMAT } else { 'human' }
$startCore  = if ($env:RYU_START_CORE) { $env:RYU_START_CORE } else { '1' }
$coreBind   = if ($env:RYU_CORE_BIND) { $env:RYU_CORE_BIND } else { '127.0.0.1:7980' }
$coreUrl    = if ($env:RYU_CORE_URL) { $env:RYU_CORE_URL } else { 'http://127.0.0.1:7980' }
# `latest` names no fixed release, so it never matches an existing install: a
# re-run of the one-liner must upgrade rather than report "already installed".
$installMarker = if ($env:RYU_INSTALL_MARKER) { $env:RYU_INSTALL_MARKER } elseif ($env:RYU_VERSION) { $env:RYU_VERSION } else { 'latest' }
$forceInstall = $env:RYU_FORCE_INSTALL -eq '1'

function Emit-Progress {
  param(
    [string]$Phase,
    [string]$Component,
    [string]$Status,
    [int]$Percent
  )
  if ($progressFormat -ne 'json') { return }
  $payload = [ordered]@{
    version = 1
    phase = $Phase
    component = $Component
    status = $Status
    percent = $Percent
  }
  Write-Output ('RYU_INSTALL_EVENT:' + ($payload | ConvertTo-Json -Compress))
}

function Fail-Install {
  param([string]$Component, [string]$Message)
  Emit-Progress 'error' $Component 'failed' 0
  throw $Message
}

# --- detect arch ------------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
  throw "Windows $arch is not supported by the prebuilt binaries (only x86_64/AMD64). Build from source: https://github.com/$repo#quick-start-self-host"
}
$suffix = 'windows-x86_64'

$base = if ($env:RYU_VERSION) {
  "$ReleaseBase/download/$($env:RYU_VERSION)"
} else {
  "$ReleaseBase/latest/download"
}

Write-Host "Installing Ryu ($suffix) into $installDir"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$replacedExisting = $false

for ($index = 0; $index -lt $binaries.Count; $index++) {
  $bin = $binaries[$index]
  $asset = "$bin-$suffix.exe"
  $url   = "$base/$asset"
  $out   = Join-Path $installDir "$bin.exe"
  $before = $index * 15
  $after = ($index + 1) * 15
  $markerPath = "$out.version"
  $markerMatches = ($installMarker -ne 'latest') -and (Test-Path $markerPath) -and ((Get-Content -Raw -Path $markerPath).Trim() -eq $installMarker)
  if ((Test-Path $out) -and $markerMatches -and -not $forceInstall) {
    Write-Host "  $bin already installed"
    Emit-Progress 'binary' $bin 'skipped' $after
    continue
  }

  Write-Host "  $bin"
  Emit-Progress 'binary' $bin 'started' $before
  $download = "$out.download"
  try {
    Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
  } catch {
    Fail-Install $bin "download failed: $url — $_"
  }

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
      Fail-Install $bin "could not download checksum $url.sha256 — refusing to install an unverified binary (set `$env:RYU_SKIP_CHECKSUM = '1' to bypass): $_"
    }
    if ($shaContent -is [byte[]]) { $shaContent = [System.Text.Encoding]::ASCII.GetString($shaContent) }
    $want = ([string]$shaContent -split '\s+')[0].Trim()
    if ($want -notmatch '^[0-9a-fA-F]{64}$') {
      Fail-Install $bin "malformed checksum file at $url.sha256 — refusing to install (set `$env:RYU_SKIP_CHECKSUM = '1' to bypass)"
    }
    $got = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
    if ($want.ToLower() -ne $got) { Fail-Install $bin "checksum mismatch for $asset (want $want, got $got)" }
  }
  # Windows refuses to overwrite a running executable (Core and the gateway it
  # spawns stay running between installs) but does allow renaming it, so move
  # the current exe aside before putting the verified download in place.
  $aside = $null
  try {
    if (Test-Path $out) {
      Get-ChildItem -Path $installDir -Filter "$bin.exe.old*" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
      $aside = "$out.old"
      if (Test-Path $aside) { $aside = "$out.old-$([DateTime]::UtcNow.Ticks)" }
      Move-Item -Force -Path $out -Destination $aside
    }
    Move-Item -Force -Path $download -Destination $out
  } catch {
    $replaceError = $_
    if ($aside -and (Test-Path $aside) -and -not (Test-Path $out)) {
      Move-Item -Force -Path $aside -Destination $out -ErrorAction SilentlyContinue
    }
    Remove-Item -Force -Path $download -ErrorAction SilentlyContinue
    Fail-Install $bin "could not replace $out — $replaceError"
  }
  if ($aside) { $replacedExisting = $true }
  Set-Content -Path "$out.version" -Value $installMarker -NoNewline
  Emit-Progress 'binary' $bin 'complete' $after
}

# --- PATH (user scope) ------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($env:RYU_NO_MODIFY_PATH -ne '1' -and ($userPath -split ';') -notcontains $installDir) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host "Added $installDir to your user PATH — open a new terminal to pick it up."
}

Write-Host ''
Write-Host "Done. Installed: $($binaries -join ', ')"

if ($startCore -eq '1') {
  $ryuHome = Split-Path -Parent $installDir
  $corePath = Join-Path $installDir 'ryu-core.exe'
  # RYU_CORE_LOG: legacy name the desktop installer still passes.
  $coreLog = if ($env:RYU_CORE_LOG_PATH) { $env:RYU_CORE_LOG_PATH } elseif ($env:RYU_CORE_LOG) { $env:RYU_CORE_LOG } else { Join-Path $ryuHome 'ryu-core.log' }
  $coreLog = [System.IO.Path]::GetFullPath($coreLog)
  $coreParent = Split-Path -Parent $coreLog
  New-Item -ItemType Directory -Force -Path $coreParent | Out-Null
  Emit-Progress 'core' 'ryu-core' 'started' 55

  function Test-CoreHealthy {
    try {
      $null = Invoke-WebRequest -Uri "$coreUrl/api/health" -UseBasicParsing -TimeoutSec 3
      return $true
    } catch {
      return $false
    }
  }

  if (-not (Test-CoreHealthy)) {
    Write-Host '  starting Ryu Core'
    $previousCoreLogPath = $env:RYU_CORE_LOG_PATH
    $env:RYU_CORE_LOG_PATH = $coreLog
    try {
      Start-Process -FilePath $corePath -ArgumentList "--bind=$coreBind" -WorkingDirectory $ryuHome -WindowStyle Hidden | Out-Null
    } finally {
      if ($null -eq $previousCoreLogPath) {
        Remove-Item Env:RYU_CORE_LOG_PATH -ErrorAction SilentlyContinue
      } else {
        $env:RYU_CORE_LOG_PATH = $previousCoreLogPath
      }
    }
  } else {
    Write-Host '  Ryu Core is already running'
    if ($replacedExisting) {
      # The running process keeps executing the previous build; only a restart
      # picks up the binaries this run just installed.
      Write-Host '  Restart Ryu Core to run the upgraded binaries; the running process is still the previous build'
    }
  }

  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-CoreHealthy) {
      $healthy = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) { Fail-Install 'ryu-core' "Ryu Core did not become healthy at $coreUrl" }
  Emit-Progress 'core' 'ryu-core' 'complete' 75

  Write-Host '  Core is provisioning bundled models, engines, skills, and defaults'
  Emit-Progress 'defaults' 'bundled-defaults' 'started' 80
  Write-Host '  Core is preinstalling Shadow, Ghost, and Island (Island stays stopped)'
  Emit-Progress 'defaults' 'shadow' 'started' 85
  Emit-Progress 'defaults' 'ghost' 'started' 90
  Emit-Progress 'defaults' 'island' 'started' 95
}

Emit-Progress 'bootstrap' 'ryu' 'complete' 100
Write-Host ''
Write-Host 'Next:'
Write-Host '  ryu-core     # already running; bundled defaults continue provisioning'
Write-Host '  ryu-cli      # in another terminal, connect the TUI to it'
Write-Host ''
Write-Host 'Point any OpenAI-compatible client at the Gateway: http://127.0.0.1:7981/v1'
