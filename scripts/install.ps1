<#
.SYNOPSIS
  Install mirb, the instant SSH port forwarder.

.DESCRIPTION
  Downloads the release archive for this machine from GitHub, verifies its SHA-256
  against the release checksums.txt, and installs mirb.exe.

  Verification is not optional and there is no switch to skip it: a flag that turns
  integrity checking off is a flag an attacker can talk a user into typing.

.EXAMPLE
  irm https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.ps1 | iex

.EXAMPLE
  # Passing arguments requires a script block, because `iex` cannot forward parameters.
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.ps1))) -Version 0.2.0

.EXAMPLE
  # Or use the environment, which survives the plain `irm | iex` form.
  $env:MIRB_VERSION = '0.2.0'; irm https://.../install.ps1 | iex
#>

param(
  [string] $Version,
  [string] $Dir,
  [switch] $NoPathUpdate,
  [switch] $Help
)

#-----------------------------------------------------------------------------
# CHANGE ME: the GitHub repository releases are published to.
# This is the only line that has to change if the project moves.
$MirbRepo = 'heysanil/mirrorball-cli'
#-----------------------------------------------------------------------------

$MirbBinary = 'mirb'
$MirbGithub = 'https://github.com'

# This script is normally dot-sourced into the caller's live session by `irm | iex`,
# so every preference we change has to be put back. Leaking ErrorActionPreference
# into someone's shell is a rude thing for an installer to do.
$MirbPrevErrorAction = $ErrorActionPreference
$MirbPrevProgress = $ProgressPreference
$ErrorActionPreference = 'Stop'
# Not cosmetic: the progress bar makes Invoke-WebRequest on Windows PowerShell 5.1
# an order of magnitude slower on large files.
$ProgressPreference = 'SilentlyContinue'

#-- output -------------------------------------------------------------------

$MirbColor = (-not $env:NO_COLOR)

function Write-Plain { param([string] $Text = '') Write-Host $Text }

function Write-Step {
  param([string] $Text)
  if ($MirbColor) { Write-Host "  $Text" -ForegroundColor DarkGray } else { Write-Host "  $Text" }
}

function Write-Note {
  param([string] $Text)
  if ($MirbColor) { Write-Host "  warning $Text" -ForegroundColor Yellow } else { Write-Host "  warning $Text" }
}

function Write-Fail {
  param([string] $Text, [string] $Hint)
  Write-Host ''
  if ($MirbColor) { Write-Host "  error $Text" -ForegroundColor Red } else { Write-Host "  error $Text" }
  if ($Hint) {
    Write-Host ''
    if ($MirbColor) { Write-Host "  $Hint" -ForegroundColor DarkGray } else { Write-Host "  $Hint" }
  }
  Write-Host ''
}

# Carries the user-facing hint alongside the message so the top-level handler can
# print both without every throw site formatting its own error block.
function New-MirbError {
  param([string] $Message, [string] $Hint)
  $e = New-Object System.Exception ($Message)
  $e.Data['Hint'] = $Hint
  return $e
}

function Show-MirbHelp {
  Write-Plain @'
Install mirb, the instant SSH port forwarder.

  install.ps1 [-Version <x.y.z>] [-Dir <path>] [-NoPathUpdate]

Options
  -Version <x.y.z>   Install a specific release. Default: the latest release.
  -Dir <path>        Install into <path>. Default: %LOCALAPPDATA%\mirb\bin.
  -NoPathUpdate      Do not touch the user PATH; print instructions instead.
  -Help              Show this message.

Environment
  MIRB_VERSION            Same as -Version.
  MIRB_INSTALL_DIR        Same as -Dir.
  MIRB_NO_PATH_UPDATE     Same as -NoPathUpdate.
  NO_COLOR               Disable colored output.
'@
}

#-- platform -----------------------------------------------------------------

function Get-MirbArchCandidates {
  # PROCESSOR_ARCHITECTURE reports the *process* architecture, so a 32-bit
  # PowerShell on 64-bit Windows reports x86. ARCHITEW6432 is how you see through
  # WOW64 to what the machine actually is, so it has to be checked first.
  $raw = $env:PROCESSOR_ARCHITEW6432
  if (-not $raw) { $raw = $env:PROCESSOR_ARCHITECTURE }
  if (-not $raw) { $raw = 'AMD64' }

  switch ($raw.ToUpperInvariant()) {
    'AMD64' { return @('x64') }
    'IA64'  { return @('x64') }
    # Windows on ARM emulates x64, so an x64 build is a working fallback rather
    # than a dead end. Native first if the release ever ships one.
    'ARM64' { return @('arm64', 'x64') }
    'X86'   { throw (New-MirbError '32-bit Windows is not supported' "mirb ships 64-bit builds only.") }
    default { throw (New-MirbError "unsupported architecture: $raw" "mirb ships x64 (and, where available, arm64) builds.") }
  }
}

function Get-MirbDefaultDir {
  # Per-user by default: no elevation prompt, and nothing lands in Program Files
  # that a later uninstall would have to ask for admin to remove.
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = $env:USERPROFILE }
  if (-not $base) { $base = $HOME }
  if (-not $base) { throw (New-MirbError 'cannot determine a default install directory' 'Pass one explicitly: -Dir C:\tools\mirb') }
  return (Join-Path $base 'mirb\bin')
}

#-- fetching -----------------------------------------------------------------

function Initialize-MirbTls {
  # Windows PowerShell 5.1 defaults to SSL3/TLS1.0, which github.com refuses.
  # PowerShell 7 negotiates properly and the enum members may not exist, so this is
  # best-effort by design.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
    Write-Debug 'could not raise TLS version; continuing'
  }
}

function Invoke-MirbDownload {
  param([string] $Uri, [string] $OutFile)
  # -UseBasicParsing matters on 5.1: without it Invoke-WebRequest reaches for the
  # Internet Explorer engine, which is absent on Server Core and on hardened images.
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

function Get-MirbLatestTag {
  # Resolve /releases/latest by seeing where GitHub redirects, not via the JSON API:
  # the API is rate limited to 60 requests/hour per IP, which turns a shared CI
  # runner into a flaky install.
  $url = "$MirbGithub/$MirbRepo/releases/latest"

  # The final-URL property moved between Windows PowerShell (HttpWebResponse) and
  # PowerShell 7 (HttpResponseMessage), so probe both rather than pick one.
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -Method Head
    $final = $null
    if ($resp.BaseResponse) {
      if ($resp.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri') {
        $final = [string] $resp.BaseResponse.ResponseUri
      } elseif ($resp.BaseResponse.RequestMessage) {
        $final = [string] $resp.BaseResponse.RequestMessage.RequestUri
      }
    }
    if ($final -and $final -match '/tag/([^/]+)/?$') { return $Matches[1] }
  } catch {
    Write-Debug "HEAD on $url failed: $($_.Exception.Message)"
  }

  # Fallback: refuse the redirect and read the Location header instead. 5.1 throws
  # on an unfollowed 3xx while 7 returns it, so both shapes are handled.
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -Method Head -MaximumRedirection 0
    $loc = [string] ($resp.Headers['Location'] | Select-Object -First 1)
  } catch {
    $loc = ''
    if ($_.Exception.Response) {
      $loc = [string] ($_.Exception.Response.Headers['Location'] | Select-Object -First 1)
    }
  }
  if ($loc -and $loc -match '/tag/([^/]+)/?$') { return $Matches[1] }

  return $null
}

#-- checksums ----------------------------------------------------------------

function Read-MirbChecksums {
  param([string] $Path)
  $map = @{}
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    # `<sha256>  <name>` from sha256sum, or `<sha256> *<name>` in binary mode.
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$') {
      $map[$Matches[2]] = $Matches[1].ToLowerInvariant()
    }
  }
  return $map
}

#-- PATH ---------------------------------------------------------------------

function Test-MirbOnPath {
  param([string] $Directory)
  $normalized = $Directory.TrimEnd('\', '/')
  foreach ($entry in ($env:Path -split ';')) {
    if ($entry -and $entry.TrimEnd('\', '/') -ieq $normalized) { return $true }
  }
  return $false
}

function Add-MirbToUserPath {
  param([string] $Directory)

  # Deliberately not setx: it silently truncates PATH at 1024 characters and has
  # eaten real people's environments. And deliberately not
  # [Environment]::SetEnvironmentVariable, which expands %VAR% references and
  # rewrites the value as REG_SZ, freezing what should stay dynamic. Going at the
  # registry directly is the only way to leave an existing REG_EXPAND_SZ intact.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { throw (New-MirbError 'could not open HKCU:\Environment') }
  try {
    $current = [string] $key.GetValue(
      'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)

    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }

    $normalized = $Directory.TrimEnd('\', '/')
    foreach ($entry in ($current -split ';')) {
      if ($entry -and $entry.TrimEnd('\', '/') -ieq $normalized) { return $false }
    }

    $updated = if ($current) { "$($current.TrimEnd(';'));$Directory" } else { $Directory }
    $key.SetValue('Path', $updated, $kind)
  } finally {
    $key.Dispose()
  }

  # So the rest of *this* session can already find mirb; new terminals pick it up
  # from the registry.
  $env:Path = "$env:Path;$Directory"
  return $true
}

#-- install ------------------------------------------------------------------

function Install-MirbBinary {
  param([string] $Source, [string] $Destination)

  # Windows refuses to overwrite a running .exe but is happy to rename one. Moving
  # the old binary aside first is what lets `install.ps1` upgrade mirb while a
  # background forwarding session is still using it.
  if (Test-Path -LiteralPath $Destination) {
    $stale = "$Destination.old-$([System.IO.Path]::GetRandomFileName())"
    try {
      Move-Item -LiteralPath $Destination -Destination $stale -Force
      Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue
    } catch {
      throw (New-MirbError "could not replace $Destination" 'Close any running mirb sessions and try again.')
    }
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

#-- main ---------------------------------------------------------------------

function Invoke-MirbInstall {
  if ($Help) { Show-MirbHelp; return }

  if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw (New-MirbError "PowerShell 5.0 or newer is required (found $($PSVersionTable.PSVersion))" 'Expand-Archive does not exist before 5.0.')
  }

  $wantVersion = if ($Version) { $Version } else { $env:MIRB_VERSION }
  $installDir = if ($Dir) { $Dir } elseif ($env:MIRB_INSTALL_DIR) { $env:MIRB_INSTALL_DIR } else { Get-MirbDefaultDir }
  $skipPath = $NoPathUpdate -or [bool] $env:MIRB_NO_PATH_UPDATE

  # @() is load-bearing: PowerShell unrolls a one-element array returned from a
  # function into a bare string, and indexing [0] into a string yields a character.
  # Without this, the x64 path -- the common case -- reports itself as "windows-x".
  $archCandidates = @(Get-MirbArchCandidates)
  Initialize-MirbTls

  Write-Plain ''
  if ($MirbColor) {
    Write-Host '  Installing mirb ' -NoNewline -ForegroundColor White
    Write-Host "(windows-$($archCandidates[0]))" -ForegroundColor DarkGray
  } else {
    Write-Plain "  Installing mirb (windows-$($archCandidates[0]))"
  }
  Write-Plain ''

  if ($wantVersion) {
    # Accept both `1.2.3` and `v1.2.3`; tags carry the v, filenames do not.
    $tag = 'v' + $wantVersion.TrimStart('v', 'V')
  } else {
    Write-Step 'resolving latest release'
    $tag = Get-MirbLatestTag
    if (-not $tag) {
      throw (New-MirbError 'could not determine the latest mirb release' 'Pass an explicit version: -Version 0.1.0')
    }
  }

  $baseUrl = "$MirbGithub/$MirbRepo/releases/download/$tag"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mirb-install-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null

  try {
    $checksumsPath = Join-Path $tmp 'checksums.txt'
    Write-Step "fetching $tag"
    try {
      Invoke-MirbDownload -Uri "$baseUrl/checksums.txt" -OutFile $checksumsPath
    } catch {
      throw (New-MirbError "no release assets found for $tag" "Looked in $baseUrl")
    }

    # The manifest is the source of truth for the asset name. Deriving the filename
    # from the tag would bake in an assumption about whether the releaser keeps the
    # `v` prefix; reading it back removes the guess and fails loudly if the naming
    # ever changes.
    $checksums = Read-MirbChecksums -Path $checksumsPath

    $asset = $null
    $arch = $null
    foreach ($candidate in $archCandidates) {
      $suffix = "-windows-$candidate.zip"
      $match = $checksums.Keys |
        Where-Object { $_.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
      if ($match) { $asset = $match; $arch = $candidate; break }
    }

    if (-not $asset) {
      throw (New-MirbError "release $tag has no Windows build for $($archCandidates -join ' or ')" "See $MirbGithub/$MirbRepo/releases/tag/$tag")
    }
    if ($arch -ne $archCandidates[0]) {
      Write-Note "no native windows-$($archCandidates[0]) build; using windows-$arch under emulation"
    }

    $expected = $checksums[$asset]
    $archivePath = Join-Path $tmp $asset

    Write-Step "downloading $asset"
    try {
      Invoke-MirbDownload -Uri "$baseUrl/$asset" -OutFile $archivePath
    } catch {
      throw (New-MirbError "download failed: $baseUrl/$asset" $_.Exception.Message)
    }

    Write-Step 'verifying checksum'
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw (New-MirbError "checksum mismatch for $asset -- refusing to install" "expected $expected, got $actual")
    }

    Write-Step 'extracting'
    $extractDir = Join-Path $tmp 'x'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force

    # Archive root first, because that is the layout the releaser produces today.
    # The recursive search is only a safety net for a future release that nests the
    # binary in a directory.
    $exeName = "$MirbBinary.exe"
    $source = Join-Path $extractDir $exeName
    if (-not (Test-Path -LiteralPath $source)) {
      $found = Get-ChildItem -Path $extractDir -Filter $exeName -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if (-not $found) {
        throw (New-MirbError "no $exeName inside $asset" 'The release archive is not laid out the way this installer expects.')
      }
      $source = $found.FullName
    }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $destination = Join-Path $installDir $exeName
    try {
      Install-MirbBinary -Source $source -Destination $destination
    } catch {
      if ($_.Exception.Data['Hint']) { throw $_.Exception }
      throw (New-MirbError "could not write to $installDir" 'Choose a writable location: -Dir "$env:LOCALAPPDATA\mirb\bin"')
    }

    # The project is "mirrorball"; the command is `mirb`. Windows symlinks need admin or
    # developer mode, so the long name ships as a .cmd shim instead — same effect, no
    # elevation, and a few hundred bytes rather than a second copy of a 66 MB binary.
    # Best-effort: failing to write the alias must never fail the install of mirb itself.
    try {
      $aliasPath = Join-Path $installDir 'mirrorball.cmd'
      $existing = Test-Path -LiteralPath $aliasPath
      if (-not $existing -or (Get-Content -LiteralPath $aliasPath -Raw -ErrorAction SilentlyContinue) -match 'mirb\.exe') {
        Set-Content -LiteralPath $aliasPath -Encoding ASCII -Value @(
          '@echo off',
          'rem Alias for mirb, installed by the mirrorball installer.',
          '"%~dp0mirb.exe" %*'
        )
      }
    } catch {
      # An unwritable alias is a cosmetic loss; mirb is already installed and working.
    }

    Write-Plain ''
    if ($MirbColor) {
      Write-Host "  mirb $($tag.TrimStart('v')) installed" -ForegroundColor Green
    } else {
      Write-Plain "  mirb $($tag.TrimStart('v')) installed"
    }
    Write-Plain ''
    if ($MirbColor) { Write-Host "    $destination" -ForegroundColor DarkGray } else { Write-Plain "    $destination" }

    $added = $false
    if (-not (Test-MirbOnPath -Directory $installDir)) {
      if (-not $skipPath) {
        try {
          $added = Add-MirbToUserPath -Directory $installDir
        } catch {
          Write-Note "could not update your PATH: $($_.Exception.Message)"
        }
      }
      Write-Plain ''
      if ($added) {
        Write-Note "added $installDir to your user PATH; restart your terminal to pick it up"
      } else {
        Write-Note "$installDir is not on your PATH. Add it:"
        Write-Plain ''
        Write-Plain "    [Environment]::SetEnvironmentVariable('Path', `"`$env:Path;$installDir`", 'User')"
      }
    }

    Write-Plain ''
    if ($MirbColor) { Write-Host '  Get started' -ForegroundColor White } else { Write-Plain '  Get started' }
    Write-Plain ''
    Write-Plain '    mirb 10.0.0.7 3000        forward a port'
    Write-Plain '    mirb ls                   list background sessions'
    Write-Plain '    mirb --help'
    Write-Plain ''
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$MirbExitCode = 0
try {
  Invoke-MirbInstall
} catch {
  $hint = $null
  if ($_.Exception.Data -and $_.Exception.Data['Hint']) { $hint = [string] $_.Exception.Data['Hint'] }
  Write-Fail -Text $_.Exception.Message -Hint $hint
  $MirbExitCode = 1
} finally {
  $ErrorActionPreference = $MirbPrevErrorAction
  $ProgressPreference = $MirbPrevProgress
}

# `exit` inside an `irm | iex` pipeline would close the user's shell, so only a real
# script invocation gets a real exit code. Piped callers read $LASTEXITCODE instead.
$global:LASTEXITCODE = $MirbExitCode
if ($PSCommandPath) { exit $MirbExitCode }
