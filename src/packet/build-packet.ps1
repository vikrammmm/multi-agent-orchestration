[CmdletBinding()]
param(
    [string]$OutputDir = '',
    [switch]$NoZip,
    [string]$SkillsSource = '',
    [switch]$SkipFixtures,
    [string]$PreviousPacket = '',
    # Development only: stage and write CHECKSUMS.txt, run no gate, build no zip, never say BUILD PASS.
    [switch]$StageOnly
)

# Assembles the delegation team packet from the packet sources and the MIT-licensed
# relay skills, writes CHECKSUMS.txt, runs the gates of PACKET-SPEC section 6 against the stage, and
# zips it with the Windows bsdtar so entry names use forward slashes (Compress-Archive on
# PowerShell 5.1 writes backslashes, which break unzipping on macOS and Linux). Any failing or
# unrunnable gate stops the build before the zip, with a non-zero exit and no BUILD PASS.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packetSrc  = $PSScriptRoot
$sharedRoot = Split-Path -Parent $packetSrc
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Split-Path -Parent $sharedRoot
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
if ([string]::IsNullOrWhiteSpace($SkillsSource)) {
    $SkillsSource = Join-Path $sharedRoot 'skills'
}
$version   =(Get-Content -LiteralPath (Join-Path $packetSrc 'VERSION') -Raw).Trim()
$stage     = Join-Path $OutputDir 'delegation-team-packet'

function Copy-Tree {
    param([string]$From, [string]$To, [string[]]$ExcludeNames = @())
    if (!(Test-Path -LiteralPath $From -PathType Container)) { throw "Missing source folder: $From" }
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Recurse -File) {
        $rel = $item.FullName.Substring($From.Length).TrimStart('\', '/')
        $top = $rel.Split('\')[0]
        if ($ExcludeNames -contains $top) { continue }
        $dest = Join-Path $To $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
    }
}

function Copy-One {
    param([string]$From, [string]$To, [switch]$Optional)
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) {
        if ($Optional) { Write-Output "WARN missing (skipped): $From"; return }
        throw "Missing source file: $From"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $To) | Out-Null
    Copy-Item -LiteralPath $From -Destination $To -Force
}

function Get-StageFiles {
    param([string]$Root)
    $list = New-Object System.Collections.ArrayList
    foreach ($item in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
        [void]$list.Add(($item.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'))
    }
    return ,($list | Sort-Object)
}

# Manifest paths are relative to their own tree; never let a manifest escape the stage.
function Copy-ManifestFile {
    param([string]$Tree, [string]$Relative, [string]$ExpectedHash)
    if ($Relative -notmatch '^[A-Za-z0-9._/-]+$' -or $Relative.StartsWith('/') -or
        @($Relative.Split('/')) -contains '..' -or @($Relative.Split('/')) -contains '.') {
        throw "Unsafe manifest path: $Tree/$Relative"
    }
    if ($ExpectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw "Missing or invalid manifest hash: $Tree/$Relative" }
    $dest = Join-Path $stage "$Tree/$Relative"
    Copy-One -From (Join-Path $sharedRoot "$Tree/$Relative") -To $dest
    $actual = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedHash) { throw "Manifest hash mismatch: $Tree/$Relative" }
}

# Runs node with the given arguments in a working folder; throws with the gate name on a non-zero
# exit. Output is streamed so the build log carries the test counts.
function Invoke-Gate {
    param([string]$Name, [string]$WorkDir, [string[]]$NodeArgs, [hashtable]$ExtraEnv = @{})
    Write-Output "GATE $Name ..."
    $saved = @{}
    foreach ($k in $ExtraEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $ExtraEnv[$k], 'Process') }
    Push-Location -LiteralPath $WorkDir
    # Windows PowerShell 5.1 turns a native command's stderr lines into error records; with
    # 'Stop' the first warning line would abort the build, so the exit code alone decides here.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:NodeExe @NodeArgs 2>&1 | ForEach-Object { "  $_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
        Pop-Location
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
    if ($code -ne 0) { throw "gate '$Name' failed (exit $code)" }
    Write-Output "GATE $Name PASS"
}

# ---- source checks ---------------------------------------------------------------------------
$lanesPath     = Join-Path $sharedRoot 'claude\delegate-lanes.json'
$fallbacksPath = Join-Path $packetSrc 'claude\lane-fallbacks.json'
$lanes     = (Get-Content -LiteralPath $lanesPath -Raw) | ConvertFrom-Json
$fallbacks = (Get-Content -LiteralPath $fallbacksPath -Raw) | ConvertFrom-Json
$laneNames = @($lanes.lanes.PSObject.Properties.Name)
foreach ($prop in $fallbacks.lanes.PSObject.Properties) {
    if ($laneNames -notcontains $prop.Name) { throw "lane-fallbacks.json names lane '$($prop.Name)', which delegate-lanes.json does not have" }
    $primary = $lanes.lanes.($prop.Name)
    $pEffort = if ($primary.PSObject.Properties.Name -contains 'effort') { [string]$primary.effort } else { '' }
    foreach ($fb in @($prop.Value)) {
        $fEffort = if ($fb.PSObject.Properties.Name -contains 'effort') { [string]$fb.effort } else { '' }
        if (([string]$fb.model -eq [string]$primary.model) -and ($fEffort -eq $pEffort)) {
            throw "lane-fallbacks.json repeats the first choice of lane '$($prop.Name)'"
        }
    }
}
Write-Output 'CHECK lane fallbacks PASS'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) { throw 'node (18 or newer) is required to run the build gates' }
$script:NodeExe = $nodeCmd.Source

# ---- stage -------------------------------------------------------------------------------
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($f in @('README.md', 'VERSION', 'install.cmd', 'install.ps1', 'install.sh')) {
    Copy-One -From (Join-Path $packetSrc $f) -To (Join-Path $stage $f) -Optional:($f -like 'install.*')
}
Copy-Tree -From (Join-Path $packetSrc 'policy') -To (Join-Path $stage 'policy')
# Ship only the sealed front desk and the current release's installable ladder files.
foreach ($manifestInfo in @(@('frontdesk', 'code-manifest.json'), @('ladder', 'manifest.json'))) {
    $tree = $manifestInfo[0]; $name = $manifestInfo[1]
    $manifestPath = Join-Path $sharedRoot "$tree/$name"
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    Copy-ManifestFile -Tree $tree -Relative $name -ExpectedHash $manifestHash
}
$frontdeskManifest = Get-Content -LiteralPath (Join-Path $stage 'frontdesk/code-manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $frontdeskManifest.files.PSObject.Properties) {
    Copy-ManifestFile -Tree 'frontdesk' -Relative $entry.Name -ExpectedHash ([string]$entry.Value)
}
$ladderManifest = Get-Content -LiteralPath (Join-Path $stage 'ladder/manifest.json') -Raw | ConvertFrom-Json
if ([string]$ladderManifest.release -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid ladder release id' }
foreach ($file in $ladderManifest.installable) {
    $rel = "releases/$($ladderManifest.release)/$file"
    $entry = $ladderManifest.files.PSObject.Properties[$rel]
    if ($null -eq $entry) { throw "Missing ladder manifest hash: $rel" }
    Copy-ManifestFile -Tree 'ladder' -Relative $rel -ExpectedHash ([string]$entry.Value)
}
Write-Output 'CHECK front desk and ladder manifests PASS'
Copy-One  -From (Join-Path $packetSrc 'claude\CLAUDE-bootstrap.md') -To (Join-Path $stage 'claude\CLAUDE-bootstrap.md')
Copy-One  -From (Join-Path $packetSrc 'codex\AGENTS-bootstrap.md') -To (Join-Path $stage 'codex\AGENTS-bootstrap.md')
Copy-One  -From $fallbacksPath -To (Join-Path $stage 'claude\lane-fallbacks.json')
Copy-Tree -From (Join-Path $packetSrc 'claude\agents') -To (Join-Path $stage 'claude\agents')
Copy-One  -From $lanesPath -To (Join-Path $stage 'claude\delegate-lanes.json')
Copy-Tree -From (Join-Path $sharedRoot 'consensus') -To (Join-Path $stage 'consensus') -ExcludeNames @('BUILD-BRIEF.txt')
$setupSrc = Join-Path $packetSrc 'setup'
if (Test-Path -LiteralPath (Join-Path $setupSrc 'resolve.mjs') -PathType Leaf) {
    Copy-Tree -From $setupSrc -To (Join-Path $stage 'setup')
} elseif ($StageOnly) {
    Write-Output "WARN setup\resolve.mjs is missing; staged without it (development staging only)"
} else {
    throw "Missing source file: $setupSrc\resolve.mjs"
}

foreach ($skill in @('codex-delegate', 'cursor-delegate', 'muse-delegate', 'delegate-setup')) {
    $from = Join-Path $SkillsSource $skill
    Copy-Tree -From $from -To (Join-Path $stage "skills\$skill")
    if ($skill -ne 'delegate-setup') {
        $relay = Join-Path $stage "skills\$skill\scripts\relay.mjs"
        if (!(Select-String -LiteralPath $relay -Pattern 'DELEGATION_DISPATCHED' -Quiet)) {
            throw "$skill relay lacks the DELEGATION_DISPATCHED marker; refusing to ship it"
        }
        if (Select-String -LiteralPath $relay -Pattern 'disable-sandbox' -Quiet) {
            throw "$skill relay carries --disable-sandbox; refusing to ship it"
        }
        # Meta's contributor tier is banned: the Muse relay must force it off on every run.
        if ($skill -eq 'muse-delegate' -and !(Select-String -LiteralPath $relay -SimpleMatch -Pattern '"--contributor-mode", "off"' -Quiet)) {
            throw "muse-delegate relay does not pass --contributor-mode off; refusing to ship it"
        }
    }
    $skillMd = Join-Path $stage "skills\$skill\SKILL.md"
    if (!(Select-String -LiteralPath $skillMd -Pattern '^license:\s*MIT' -Quiet)) {
        throw "$skill SKILL.md does not declare the MIT license; refusing to ship it"
    }
}

# The bootstrap's first line is what the installers look for when replacing the section.
$firstLine = (Get-Content -LiteralPath (Join-Path $stage 'claude\CLAUDE-bootstrap.md') -TotalCount 1)
if ($firstLine -ne '## Delegation (shared rulebook)') { throw "CLAUDE-bootstrap.md must start with '## Delegation (shared rulebook)'" }

# ---- checksums ---------------------------------------------------------------------------
$lines = New-Object System.Collections.ArrayList
foreach ($item in (Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName)) {
    $rel = $item.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'
    if ($rel -eq 'CHECKSUMS.txt') { continue }
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$lines.Add("$hash  $rel")
}
$sorted = $lines | Sort-Object { $_.Substring(66) }
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage 'CHECKSUMS.txt'), (($sorted -join "`n") + "`n"), $enc)

$count = (Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object).Count
Write-Output "STAGE=$stage"
Write-Output "VERSION=$version"
Write-Output "FILES=$count"

if ($StageOnly) {
    Write-Output 'RESULT=STAGED (development staging: no gate run, no zip; not a release)'
    exit 0
}

# ---- gates (PACKET-SPEC section 6) ---------------------------------------------------------
$before = Get-StageFiles -Root $stage
$ledgerTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("packet-build-ledger-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $ledgerTmp | Out-Null
try {
    Invoke-Gate -Name 'consensus tests' -WorkDir (Join-Path $stage 'consensus') -NodeArgs @('--test') -ExtraEnv @{ CONSENSUS_LEDGER = $ledgerTmp }
} finally {
    Remove-Item -LiteralPath $ledgerTmp -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath (Join-Path $stage 'setup') -PathType Container) {
    Invoke-Gate -Name 'setup tests' -WorkDir (Join-Path $stage 'setup') -NodeArgs @('--test')
} elseif (!$SkipFixtures) {
    throw "gate 'setup tests' cannot run: the stage has no setup folder"
}
# The Muse relay's contributor-tier guard, against the relay that ships (fake muse; no network, no account).
$museRelayTests = Join-Path $packetSrc 'tests\muse-relay.test.mjs'
if (!(Test-Path -LiteralPath $museRelayTests -PathType Leaf)) { throw "gate 'muse relay tests' cannot run: $museRelayTests is missing" }
Invoke-Gate -Name 'muse relay tests' -WorkDir $packetSrc -NodeArgs @('--test', $museRelayTests) -ExtraEnv @{ MUSE_RELAY = (Join-Path $stage 'skills\muse-delegate\scripts\relay.mjs') }
if ($SkipFixtures) {
    Write-Output 'GATE fixtures SKIPPED (-SkipFixtures)'
} else {
    $harness = Join-Path $packetSrc 'tests\fixtures.mjs'
    if (!(Test-Path -LiteralPath $harness -PathType Leaf)) { throw "gate 'fixtures' cannot run: $harness is missing" }
    # install.sh is tested too, so the build needs Git Bash (the harness would otherwise skip it).
    $gitBash = @('C:\Program Files\Git\bin\bash.exe', 'C:\Program Files (x86)\Git\bin\bash.exe') |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($null -eq $gitBash -and $null -eq (Get-Command 'bash.exe' -ErrorAction SilentlyContinue)) {
        throw "gate 'fixtures' cannot run: Git Bash (bash.exe) is needed to test install.sh"
    }
    # Parallel shards: bash on Windows is slow, and every scenario uses its own temporary home.
    $harnessArgs = @($harness, '--packet', $stage, '--jobs', '8')
    if ([string]::IsNullOrWhiteSpace($PreviousPacket)) {
        $prev = Get-ChildItem -LiteralPath $OutputDir -Filter 'delegation-team-packet-*.zip' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne "delegation-team-packet-$version.zip" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($null -ne $prev) { $PreviousPacket = $prev.FullName }
    }
    if (![string]::IsNullOrWhiteSpace($PreviousPacket)) { $harnessArgs += @('--previous', $PreviousPacket) }
    Invoke-Gate -Name 'fixtures' -WorkDir $packetSrc -NodeArgs $harnessArgs
}
$after = Get-StageFiles -Root $stage
if (($before -join "`n") -ne ($after -join "`n")) { throw 'the gates changed the staged packet (files added or removed); refusing to zip it' }
foreach ($line in $sorted) {
    $hash = $line.Substring(0, 64); $rel = $line.Substring(66)
    $now = (Get-FileHash -LiteralPath (Join-Path $stage ($rel -replace '/', '\')) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($now -ne $hash) { throw "the gates changed $rel in the staged packet; refusing to zip it" }
}

# ---- zip ---------------------------------------------------------------------------------
if (!$NoZip) {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (!(Test-Path -LiteralPath $tar)) { throw "Windows tar.exe not found at $tar; cannot build the zip" }
    $zip = Join-Path $OutputDir "delegation-team-packet-$version.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    & $tar -a -c -f $zip -C $OutputDir 'delegation-team-packet'
    if ($LASTEXITCODE -ne 0) { throw "tar exited $LASTEXITCODE" }
    $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $zip).Length
    Write-Output "ZIP=$zip"
    Write-Output "ZIP_BYTES=$size"
    Write-Output "ZIP_SHA256=$zipHash"
}
if ($SkipFixtures) { Write-Output 'RESULT=BUILD PASS (fixtures skipped)' } else { Write-Output 'RESULT=BUILD PASS' }
