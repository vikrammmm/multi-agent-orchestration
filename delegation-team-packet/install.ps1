[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Uninstall,
    [string]$TargetRoot = '',
    [switch]$SelfTest,
    [switch]$AllowDowngrade,
    [string]$Unavailable = '',
    [switch]$ClearUnavailable,
    [string]$Repos = '',
    [string]$Credentials = '',
    [string]$Knowledge = '',
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$RemainingArgs = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── Double-dash argument aliases ─────────────────────────────────────────────
$requestedMode = ''
$i = 0
while ($i -lt $RemainingArgs.Count) {
    $a = $RemainingArgs[$i]
    if ($a -ceq '--mode' -or $a.StartsWith('--mode=', [StringComparison]::Ordinal)) {
        if ($a -ceq '--mode') {
            $i++
            $requestedMode = if ($i -lt $RemainingArgs.Count) { $RemainingArgs[$i] } else { '' }
        } else {
            $requestedMode = $a.Substring('--mode='.Length)
        }
        if ($requestedMode -cnotin @('desktop', 'server')) {
            [Console]::Error.WriteLine("Invalid --mode value: '$requestedMode' (expected desktop or server)")
            exit 1
        }
        $i++
        continue
    }
    switch ($a) {
        '--dry-run'          { $DryRun          = [switch]$true }
        '--yes'              { $Yes             = [switch]$true }
        '--uninstall'        { $Uninstall       = [switch]$true }
        '--self-test'        { $SelfTest        = [switch]$true }
        '--allow-downgrade'  { $AllowDowngrade  = [switch]$true }
        '--clear-unavailable'{ $ClearUnavailable= [switch]$true }
        '--home'             {
            $i++
            if ($i -lt $RemainingArgs.Count) { $TargetRoot = $RemainingArgs[$i] }
        }
        '--unavailable'      {
            $i++
            if ($i -lt $RemainingArgs.Count) { $Unavailable = $RemainingArgs[$i] }
        }
        '--repos'            {
            $i++
            if ($i -lt $RemainingArgs.Count) { $Repos = $RemainingArgs[$i] }
        }
        '--credentials' { $i++; if ($i -lt $RemainingArgs.Count) { $Credentials = $RemainingArgs[$i] } }
        '--knowledge' { $i++; if ($i -lt $RemainingArgs.Count) { $Knowledge = $RemainingArgs[$i] } }
        '--help' { Write-Output 'Options: --mode desktop|server (also --mode=<value>) --credentials <folder> --knowledge <folder> --repos <folder> --home <dir> --yes --dry-run --uninstall'; exit 0 }
    }
    $i++
}

$PacketRoot   = $PSScriptRoot
$EncUtf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Ensure-Dir {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256OrAbsent {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'absent' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Bytes {
    param([byte[]]$Bytes)
    $ms = New-Object System.IO.MemoryStream(,$Bytes)
    return (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, $EncUtf8NoBom)
}

function Read-Utf8 {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path)
}

function Get-ToolVersion {
    param([string]$Name, [int]$TimeoutMs = 8000)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    $src = $cmd.Source
    $tmpOut = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.txt')
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = '/d /s /c ""' + $src + '" --version > "' + $tmpOut + '" 2>&1"'
        $psi.CreateNoWindow = $true
        $psi.UseShellExecute = $false
        $p = [System.Diagnostics.Process]::Start($psi)
        $exited = $p.WaitForExit($TimeoutMs)
        if (-not $exited) {
            try { $p.Kill() } catch {}
            return 'found (version unknown)'
        }
        if (Test-Path -LiteralPath $tmpOut) {
            $v = Get-Content -LiteralPath $tmpOut -Raw -ErrorAction SilentlyContinue
            if ($v) { return $v.Trim() }
        }
        return 'found (version unknown)'
    } catch {
        return 'found (version unknown)'
    } finally {
        Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
    }
}

function Compare-SemVer {
    param([string]$A, [string]$B)
    $pa = if ($A -match '(\d+)\.(\d+)\.(\d+)') { @([int]$Matches[1],[int]$Matches[2],[int]$Matches[3]) } else { return 0 }
    $pb = if ($B -match '(\d+)\.(\d+)\.(\d+)') { @([int]$Matches[1],[int]$Matches[2],[int]$Matches[3]) } else { return 0 }
    for ($k = 0; $k -lt 3; $k++) {
        if ($pa[$k] -lt $pb[$k]) { return -1 }
        if ($pa[$k] -gt $pb[$k]) { return  1 }
    }
    return 0
}

function Compare-PacketVersion {
    param([string]$A, [string]$B)
    # Returns -1 (A<B), 0 (A=B), 1 (A>B). Format: MAJOR.MINOR.PATCH. Any other shape (earlier packets carried
    # dated numbers) counts as older than every MAJOR.MINOR.PATCH version.
    function Parse-PV($v) {
        if ($v -match '^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$') {
            return @([int]$Matches[1],[int]$Matches[2],[int]$Matches[3])
        }
        return $null
    }
    $pa = Parse-PV $A
    $pb = Parse-PV $B
    if ($null -eq $pa) { return -1 }
    if ($null -eq $pb) { return  1 }
    for ($k = 0; $k -lt 3; $k++) {
        if ($pa[$k] -lt $pb[$k]) { return -1 }
        if ($pa[$k] -gt $pb[$k]) { return  1 }
    }
    return 0
}

function Get-NodeMajor {
    param([string]$VersionStr)
    if ($VersionStr -match '(\d+)') { return [int]$Matches[1] }
    return 0
}

function Get-VersionXYZ {
    param([string]$Full)
    if ($Full -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
    return ''
}

function Get-CanonicalPath {
    # Resolves every existing component of the path, following junctions and symbolic links
    # (Resolve-Path does not), so a path that leads out through a link is judged by where it really
    # points. Components that do not exist yet are appended as written. Returns '' when a link
    # cannot be resolved; callers treat '' as outside the owned locations.
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $hops = 0
    while ($true) {
        $root  = [System.IO.Path]::GetPathRoot($full)
        $parts = @($full.Substring($root.Length).Split('\') | Where-Object { $_ -ne '' })
        $cur   = $root.TrimEnd('\')
        $next  = $null
        for ($i = 0; $i -lt $parts.Count; $i++) {
            $step = $cur + '\' + $parts[$i]
            $item = Get-Item -LiteralPath $step -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) {
                if (Test-Path -LiteralPath $step) { return '' }   # exists but cannot be read
                return ((@($cur) + $parts[$i..($parts.Count - 1)]) -join '\')
            }
            if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
                $hops++
                if ($hops -gt 32) { return '' }
                $target = [string](@($item.Target) | Select-Object -First 1)
                if ([string]::IsNullOrWhiteSpace($target)) { return '' }
                if ($target.StartsWith('\??\')) { $target = $target.Substring(4) }
                if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $cur $target }
                $next = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
                if ($i + 1 -lt $parts.Count) { $next += '\' + ($parts[($i + 1)..($parts.Count - 1)] -join '\') }
                break
            }
            $cur = $step
        }
        if ($null -eq $next) { return $cur }
        $full = $next
    }
}

# The owned locations, made canonical the same way (so a home whose .claude folder is itself a
# link still matches its own files). Folders end with '\'; single files do not.
$script:OwnedCanon = $null
function Get-OwnedCanon {
    param([string]$HomeCanon)
    if ($null -eq $script:OwnedCanon -or $script:OwnedCanon.Home -ne $HomeCanon) {
        $dirs = foreach ($rel in @('.config\delegate-skills', '.claude\skills\consensus',
                '.claude\skills\codex-delegate', '.claude\skills\cursor-delegate',
                '.claude\skills\muse-delegate', '.claude\skills\delegate-setup',
                '.agents\skills\consensus')) {
            $c = Get-CanonicalPath -Path ($HomeCanon + '\' + $rel)
            if ($c) { $c.ToLowerInvariant() + '\' }
        }
        $files = foreach ($rel in @('.claude\agents\explore.md', '.claude\agents\implementer.md',
                '.claude\agents\researcher.md', '.claude\agents\verifier.md', '.claude\agents\haiku-helper.md',
                '.claude\CLAUDE.md')) {
            $c = Get-CanonicalPath -Path ($HomeCanon + '\' + $rel)
            if ($c) { $c.ToLowerInvariant() }
        }
        $script:OwnedCanon = @{ Home = $HomeCanon; Dirs = @($dirs); Files = @($files) }
    }
    return $script:OwnedCanon
}

function Test-OwnedAndInside {
    param([string]$CanonPath, [string]$HomeCanon)
    if ([string]::IsNullOrEmpty($CanonPath)) { return $false }
    $owned = Get-OwnedCanon -HomeCanon $HomeCanon
    $p = $CanonPath.TrimEnd('\').ToLowerInvariant()
    foreach ($o in $owned.Dirs)  { if (($p + '\').StartsWith($o)) { return $true } }
    foreach ($o in $owned.Files) { if ($p -eq $o) { return $true } }
    return $false
}

function Render-Text {
    param([string]$Text, [hashtable]$Vars)
    foreach ($k in $Vars.Keys) {
        $Text = $Text.Replace('{{' + $k + '}}', $Vars[$k])
    }
    return $Text
}

function Test-LadderContainment {
    $paths = @($FrontdeskDir, $FrontdeskReceipt, (Join-Path $HomeDir '.config\delegate-skills\.backups\frontdesk'))
    foreach ($rel in @('bin', 'bin.prev', 'generations', 'state', 'logs', 'current.json')) {
        $paths += Join-Path $FrontdeskDir $rel
    }
    foreach ($path in $paths) {
        if (-not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath $path) -HomeCanon $CanonicalHome)) { return $false }
    }
    $generations = Join-Path $FrontdeskDir 'generations'
    if (Test-Path -LiteralPath $generations -PathType Container) {
        foreach ($item in Get-ChildItem -LiteralPath $generations -Force) {
            if (-not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath $item.FullName) -HomeCanon $CanonicalHome)) { return $false }
        }
    }
    return $true
}

function Get-TeamFrontdeskReceipt {
    try {
        $r = Read-Utf8 $FrontdeskReceipt | ConvertFrom-Json
        if ($null -ne $r -and $r.PSObject.Properties['installedBy'] -and $r.installedBy -ceq 'team-packet' -and
            $r.PSObject.Properties['hooks'] -and $r.hooks -is [PSCustomObject] -and @($r.hooks.PSObject.Properties).Count -eq 0) {
            return $r
        }
    } catch {}
    return $null
}

function Remove-LadderTree {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    # Delete links themselves, including junctions; never enumerate their targets.
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $item.Delete(); return }
    if (-not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath $Path) -HomeCanon $CanonicalHome)) {
        throw "Refusing to remove a ladder path outside the owned folders: $Path"
    }
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Remove-LadderTree $child.FullName }
        $item.Delete()
    } else { Remove-Item -LiteralPath $Path -Force }
}

function Initialize-Ladder {
    $script:ladderOwned = $false
    $script:ladderLastInstalled = $null
    if ($null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['ladder'] -and $null -ne $prevReceipt.ladder) {
        if ($prevReceipt.ladder.PSObject.Properties['owned']) { $script:ladderOwned = $prevReceipt.ladder.owned -is [bool] -and $prevReceipt.ladder.owned -eq $true }
        if ($prevReceipt.ladder.PSObject.Properties['lastInstalled']) { $script:ladderLastInstalled = $prevReceipt.ladder.lastInstalled }
    }
    $script:ladderStatus = 'pending'
    $script:ladderReason = 'installation pending'
    if (-not $nodeVersionOk) {
        $script:ladderStatus = 'skipped'; $script:ladderReason = 'needs Node 18+'
    } elseif (-not (Test-LadderContainment)) {
        $script:ladderStatus = 'skipped'; $script:ladderReason = 'a link leads outside the owned folders'
    } else {
        $folderExists = $null -ne (Get-Item -LiteralPath $FrontdeskDir -Force -ErrorAction SilentlyContinue)
        $receiptExists = $null -ne (Get-Item -LiteralPath $FrontdeskReceipt -Force -ErrorAction SilentlyContinue)
        if (($folderExists -or $receiptExists) -and -not ($ladderOwned -and
            (-not $receiptExists -or $null -ne (Get-TeamFrontdeskReceipt)))) {
            $script:ladderStatus = 'kept'; $script:ladderReason = 'a front desk installed outside this packet is here; left as it is'
        }
    }
}

function Get-LadderProfileLine {
    if (($ladderStatus -eq 'installed' -or $ladderStatus -eq 'unchanged' -or $ladderStatus -eq 'pending') -and $null -ne $ladderLastInstalled) {
        return ('- Role ladder: installed (release {0}, front desk {1}); ask it with node "{2}/.config/delegate-skills/frontdesk/bin/role.mjs" plan "<role>"' -f
            $ladderLastInstalled.release, $ladderLastInstalled.frontdesk, ($HomeDir -replace '\\','/'))
    }
    return "- Role ladder: not installed ($ladderReason)"
}

function Get-LadderSummary {
    switch ($ladderStatus) {
        'skipped' { return "Ladder: SKIP ($ladderReason)" }
        'kept' { return "Ladder: KEEP ($ladderReason)" }
        'failed' { return "Ladder: not installed ($ladderReason); the previous state is kept" }
        'failed-rollback-incomplete' { return "Ladder: install failed and its rollback is incomplete ($ladderReason); see the front desk backups" }
        default { return "Ladder: $ladderStatus ($ladderReason)" }
    }
}

function Invoke-LadderInstall {
    Write-Output 'Ladder'
    if ($ladderStatus -ne 'pending') { Write-Output ('  ' + (Get-LadderSummary)); return }
    # Recheck destinations immediately before the front desk can write.
    if (-not (Test-LadderContainment)) {
        $script:ladderStatus = 'skipped'; $script:ladderReason = 'a link leads outside the owned folders'
        Write-Output ('  ' + (Get-LadderSummary)); return
    }
    $declared = if ($unavailableList.Count -gt 0) { $unavailableList -join ',' } else { '-' }
    $fdArgs = @((Join-Path $PacketRoot 'frontdesk\install-frontdesk.mjs'), 'install', '--no-hooks', '--no-live-check',
        '--installed-by', 'team-packet', '--exclude-required', 'qwen-local', '--exclude-declared', $declared,
        '--shared-root', $PacketRoot, '--home', $HomeDir)
    if (-not $DryRun) { $fdArgs += '--yes' }
    $savedHooks = $env:FRONTDESK_TEST_HOOKS; $savedFail = $env:FRONTDESK_TEST_FAIL
    $eap = $ErrorActionPreference
    $code = 1; $lines = @()
    try {
        # These variables apply only to this one child, and are restored even on failure.
        if ($env:TEAM_LADDER_TEST_FAIL) { $env:FRONTDESK_TEST_HOOKS = '1'; $env:FRONTDESK_TEST_FAIL = $env:TEAM_LADDER_TEST_FAIL }
        $ErrorActionPreference = 'Continue'
        $lines = @(& $nodeCmd.Source @fdArgs 2>&1 | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
    } catch { $lines += $_.Exception.Message } finally {
        $ErrorActionPreference = $eap
        $env:FRONTDESK_TEST_HOOKS = $savedHooks; $env:FRONTDESK_TEST_FAIL = $savedFail
    }
    foreach ($line in $lines) { Write-Output "  $line" }
    if ($code -ne 0) {
        $script:ladderStatus = if ($code -eq 4) { 'failed-rollback-incomplete' } else { 'failed' }
        $errors = @($lines | Where-Object { $_ -match '^install-frontdesk:' })
        $script:ladderReason = if ($errors.Count) { $errors[0] } elseif ($lines.Count) { $lines[0] } else { "front desk exited $code" }
    } elseif (-not $DryRun) {
        $r = Get-TeamFrontdeskReceipt
        if ($null -eq $r) {
            $script:ladderStatus = 'failed'; $script:ladderReason = 'front desk returned success without a readable team receipt'
        } else {
            $script:ladderStatus = if (($lines -join "`n") -match 'already installed, nothing to do') { 'unchanged' } else { 'installed' }
            $script:ladderReason = if ($ladderStatus -eq 'unchanged') { 'already installed, nothing to do' } else { 'installed without hooks' }
            if ($ladderStatus -ne 'unchanged' -or $null -eq $ladderLastInstalled) {
                $script:ladderLastInstalled = [ordered]@{ release = $r.release; generation = $r.generation; frontdesk = $r.frontdesk; at = [DateTime]::UtcNow.ToString('o') }
            }
            $script:ladderOwned = $true
        }
    }
}

# Codex alone uses this byte splice. Never send AGENTS.md through the CLAUDE.md normalizer.
function Get-CodexScan {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes) { $Bytes = [byte[]]@() }
    $start = -1; $end = $Bytes.Length; $count = 0; $lineStart = 0; $eol = "`n"; $firstBreak = $true
    while ($lineStart -lt $Bytes.Length) {
        $lineEnd = $lineStart
        while ($lineEnd -lt $Bytes.Length -and $Bytes[$lineEnd] -ne 10) { $lineEnd++ }
        $textEnd = $lineEnd
        if ($lineEnd -lt $Bytes.Length) {
            if ($firstBreak) { if ($lineEnd -gt 0 -and $Bytes[$lineEnd - 1] -eq 13) { $eol = "`r`n" }; $firstBreak = $false }
            if ($textEnd -gt $lineStart -and $Bytes[$textEnd - 1] -eq 13) { $textEnd-- }
        }
        $textStart = $lineStart
        if ($lineStart -eq 0 -and $Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) { $textStart = 3 }
        $line = [Text.Encoding]::ASCII.GetString($Bytes, $textStart, [Math]::Max(0, $textEnd - $textStart))
        if ($start -ge 0 -and $end -eq $Bytes.Length -and $textStart -gt $start -and $line.StartsWith('## ')) { $end = $lineStart }
        if ($line -match '^## Delegation \(shared rulebook\)[ \t]*$') {
            $count++; if ($count -eq 1) { $start = $textStart }
        }
        $lineStart = $lineEnd + 1
    }
    return [PSCustomObject]@{ Count = $count; Start = $start; End = $end; Size = $Bytes.Length; Eol = $eol }
}

function Get-CodexRecord {
    param($Receipt)
    if ($null -eq $Receipt -or -not $Receipt.PSObject.Properties['codexSection'] -or $null -eq $Receipt.codexSection) { return $null }
    $r = $Receipt.codexSection
    foreach ($name in @('owned', 'path', 'created', 'separator')) { if (-not $r.PSObject.Properties[$name]) { return $null } }
    if ($r.owned -isnot [bool] -or -not $r.owned -or $r.created -isnot [bool] -or
        $r.path -isnot [string] -or [string]::IsNullOrWhiteSpace($r.path) -or $r.separator -isnot [string] -or
        @('', "`n", "`n`n", "`r`n", "`r`n`r`n") -notcontains $r.separator) { return $null }
    return $r
}

function Get-CodexSkipReason {
    param([switch]$ForUninstall)
    $script:CodexCanonical = Get-CanonicalPath $CodexAgentsFile
    $prefix = $CanonicalHome.TrimEnd('\') + '\'
    if (-not $CodexCanonical -or -not $CodexCanonical.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return 'a link leads outside this home' }
    if ($env:CODEX_HOME -and (Get-CanonicalPath $env:CODEX_HOME) -ine (Get-CanonicalPath (Join-Path $HomeDir '.codex'))) {
        return "CODEX_HOME points to $($env:CODEX_HOME), outside this home: add the section there yourself"
    }
    if (-not $ForUninstall -and -not $hasCodex) { return 'needs Codex' }
    return ''
}

function Get-CodexBytes {
    param([byte[]]$Original, $Scan, [byte[]]$Rendered, [string]$Separator = '', [switch]$Remove)
    $ms = New-Object IO.MemoryStream
    try {
        if ($Scan.Start -lt 0) {
            if ($Original.Length) { $ms.Write($Original, 0, $Original.Length) }
            if (-not $Remove) {
                $sepBytes = $EncUtf8NoBom.GetBytes($Separator)
                if ($sepBytes.Length) { $ms.Write($sepBytes, 0, $sepBytes.Length) }
                if ($Rendered.Length) { $ms.Write($Rendered, 0, $Rendered.Length) }
            }
        } else {
            $prefixLength = $Scan.Start
            if ($Remove -and $Scan.End -eq $Original.Length -and $Separator.Length) {
                $sepBytes = $EncUtf8NoBom.GetBytes($Separator)
                $matchesSep = $prefixLength -ge $sepBytes.Length
                if ($matchesSep) { for ($i = 0; $i -lt $sepBytes.Length; $i++) { if ($Original[$prefixLength - $sepBytes.Length + $i] -ne $sepBytes[$i]) { $matchesSep = $false; break } } }
                if ($matchesSep) { $prefixLength -= $sepBytes.Length }
            }
            if ($prefixLength) { $ms.Write($Original, 0, $prefixLength) }
            if (-not $Remove -and $Rendered.Length) { $ms.Write($Rendered, 0, $Rendered.Length) }
            if ($Scan.End -lt $Original.Length) { $ms.Write($Original, $Scan.End, $Original.Length - $Scan.End) }
        }
        return ,$ms.ToArray()
    } finally { $ms.Dispose() }
}

function Initialize-CodexSection {
    param($Previous, [switch]$ForUninstall)
    $script:CodexPreviousRecord = Get-CodexRecord $Previous
    $script:CodexRecord = $CodexPreviousRecord
    $script:CodexAction = 'SKIP'; $script:CodexReason = Get-CodexSkipReason -ForUninstall:$ForUninstall
    $script:CodexSourceExists = $false; $script:CodexOriginal = [byte[]]@(); $script:CodexResult = [byte[]]@()
    if ($CodexReason) {
        if (-not $ForUninstall -and $CodexReason -eq 'needs Codex' -and $null -ne $CodexRecord) {
            $script:CodexAction = 'KEEP'; $script:CodexReason = 'Codex not found; left as installed'
        }
        return
    }
    if ($ForUninstall -and ($null -eq $CodexRecord -or $CodexRecord.path -ine $CodexCanonical)) {
        $script:CodexAction = 'KEEP'; $script:CodexReason = 'Codex section not owned at this canonical path'; return
    }
    $script:CodexSourceExists = Test-Path -LiteralPath $CodexAgentsFile
    try { if ($CodexSourceExists) { $script:CodexOriginal = [IO.File]::ReadAllBytes($CodexAgentsFile) } }
    catch { Write-Output "ERROR: could not read $CodexAgentsFile; no changes made"; exit 2 }
    $scan = Get-CodexScan -Bytes $CodexOriginal
    if ($scan.Count -gt 1) { Write-Output 'ERROR: AGENTS.md has more than one "## Delegation (shared rulebook)" section; no changes made'; exit 2 }
    if ($ForUninstall) {
        $script:CodexResult = Get-CodexBytes -Original $CodexOriginal -Scan $scan -Rendered ([byte[]]@()) -Separator $CodexRecord.separator -Remove
        $script:CodexAction = 'REMOVE'; return
    }
    $ownedHere = $null -ne $CodexRecord -and $CodexRecord.path -ieq $CodexCanonical
    if ($scan.Count -eq 1 -and -not $ownedHere) {
        $script:CodexAction = 'KEEP'; $script:CodexReason = 'a "Delegation (shared rulebook)" section the packet did not write is here; left as it is'; return
    }
    $vars = @{ SHARED_ROOT = ($PolicyDir -replace '\\','/'); PROFILE = 'team'; FOLDERS = $foldersSection }
    $section = Render-Text -Text (Read-Utf8 (Join-Path $PacketRoot 'codex\AGENTS-bootstrap.md')) -Vars $vars
    $section = (($section -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n") + "`n")
    if ($section.Contains('{{') -or @([regex]::Matches($section, '(?m)^## ')).Count -ne 1) { throw 'Invalid Codex bootstrap template' }
    if ($scan.End -lt $scan.Size -and $scan.Start -ge 0) { $section += "`n" }
    $rendered = $EncUtf8NoBom.GetBytes($section.Replace("`n", $scan.Eol))
    $sep = ''
    if ($scan.Start -lt 0) {
        if ($CodexOriginal.Length) { $sep = if ($CodexOriginal[$CodexOriginal.Length - 1] -eq 10) { $scan.Eol } else { $scan.Eol + $scan.Eol } }
        $script:CodexRecord = [PSCustomObject][ordered]@{ owned = $true; path = $CodexCanonical; created = (-not $CodexSourceExists); separator = $sep }
    }
    $script:CodexResult = Get-CodexBytes -Original $CodexOriginal -Scan $scan -Rendered $rendered -Separator $sep
    $script:CodexAction = if (-not $CodexSourceExists) { 'CREATE' } elseif ((Get-Sha256Bytes $CodexOriginal) -eq (Get-Sha256Bytes $CodexResult)) { 'UNCHANGED' } else { 'UPDATE' }
}

function Write-CodexSection {
    param([switch]$ForUninstall)
    if ($CodexAction -notin @('CREATE','UPDATE','REMOVE')) { return }
    $reason = Get-CodexSkipReason -ForUninstall:$ForUninstall
    if ($reason -or $null -eq $CodexRecord -or $CodexRecord.path -ine $CodexCanonical) {
        Write-Output "  SKIP ($reason): $CodexAgentsFile (delegation section)"
        $script:CodexRecord = $CodexPreviousRecord; $script:CodexAction = 'SKIP'; $script:CodexReason = $reason; return
    }
    $existsNow = Test-Path -LiteralPath $CodexAgentsFile
    if ($existsNow -ne $CodexSourceExists -or ($existsNow -and (Get-Sha256 $CodexAgentsFile) -ne (Get-Sha256Bytes $CodexOriginal))) {
        Write-Output "  KEEP (changed since planning): $CodexAgentsFile"
        $script:CodexRecord = $CodexPreviousRecord; $script:CodexAction = 'KEEP'; $script:CodexReason = 'changed since planning'; return
    }
    if ($ForUninstall -and $CodexRecord.created -and $CodexResult.Length -eq 0) {
        if ($existsNow) { Remove-Item -LiteralPath $CodexAgentsFile -Force }
    } elseif ($existsNow -or -not $ForUninstall) {
        Ensure-Dir (Split-Path -Parent $CodexAgentsFile)
        [IO.File]::WriteAllBytes($CodexAgentsFile, $CodexResult)
        if ((Get-Sha256 $CodexAgentsFile) -ne (Get-Sha256Bytes $CodexResult)) { throw 'Codex section post-write hash mismatch' }
    }
}

function Get-EntryText {
    if (-not $hasClaude -and -not $hasCodex) {
        return ('No instructions file written: tell your agent to read {0}/POLICY.md before nontrivial work (Muse also finds the consensus skill).' -f ($PolicyDir -replace '\\','/'))
    }
    $entries = @()
    if ($hasClaude) { $entries += 'Claude Code (CLAUDE.md section)' }
    if ($hasCodex -and $CodexAction -in @('CREATE','UPDATE','UNCHANGED')) { $entries += 'Codex (AGENTS.md section)' }
    if ($entries.Count) { return '- Rulebook entry: ' + ($entries -join ', ') }
    return "- Rulebook entry: not written ($CodexReason)"
}

function Get-DelegationSectionBounds {
    param([string]$Text)
    $m = [regex]::Match($Text, '(?m)^## Delegation \(shared rulebook\) *$')
    if (-not $m.Success) { return $null }
    $start = $m.Index
    $nextM = ([regex]'(?m)^## ').Match($Text, $start + 1)
    $end = if ($nextM.Success) { $nextM.Index } else { $Text.Length }
    return @{ Start = $start; End = $end }
}

function Invoke-ClaudeMdSplice {
    param([string]$Path, [string]$NewSection, [bool]$IsUninstall)
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($IsUninstall) { return }
        Ensure-Dir -Path (Split-Path -Parent $Path)
        Write-Utf8NoBom -Path $Path -Text ($NewSection + "`n")
        return
    }
    $raw  = Read-Utf8 -Path $Path
    $text = $raw -replace "`r`n","`n" -replace "`r","`n"
    $count = ([regex]::Matches($text, '(?m)^## Delegation \(shared rulebook\) *$')).Count
    if ($count -gt 1) {
        Write-Output "ERROR: CLAUDE.md has $count '## Delegation (shared rulebook)' lines; cannot safely modify it"
        exit 2
    }
    if ($count -eq 0) {
        if ($IsUninstall) { return }
        $trimmed = $text.TrimEnd("`n")
        Write-Utf8NoBom -Path $Path -Text ($trimmed + "`n`n" + $NewSection)
        return
    }
    $b = Get-DelegationSectionBounds -Text $text
    if ($IsUninstall) {
        $delStart = $b.Start
        if ($delStart -ge 2 -and $text[$delStart-1] -eq "`n" -and $text[$delStart-2] -eq "`n") {
            $delStart = $delStart - 1
        }
        Write-Utf8NoBom -Path $Path -Text ($text.Substring(0,$delStart) + $text.Substring($b.End))
    } else {
        Write-Utf8NoBom -Path $Path -Text ($text.Substring(0,$b.Start) + $NewSection + "`n" + $text.Substring($b.End))
    }
}

function Get-CurrentDelegationSection {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = (Read-Utf8 -Path $Path) -replace "`r`n","`n" -replace "`r","`n"
    $b = Get-DelegationSectionBounds -Text $text
    if ($null -eq $b) { return $null }
    return $text.Substring($b.Start, $b.End - $b.Start)
}

# Backup-File: backs up $FilePath into $BackupDir, re-hashes the backup.
# Returns $true on success, $false on failure.
function Backup-File {
    param([string]$FilePath, [string]$HomeRoot, [string]$BackupDir)
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return $true }
    try {
        Ensure-Dir -Path $BackupDir
    } catch {
        return $false
    }
    $rel  = $FilePath.Substring($HomeRoot.Length).TrimStart('\','/')
    $flat = $rel -replace '[\\\/]','-'
    $dest = Join-Path $BackupDir $flat
    try {
        Copy-Item -LiteralPath $FilePath -Destination $dest -Force
        $srcHash  = Get-Sha256 -Path $FilePath
        $destHash = Get-Sha256 -Path $dest
        return ($srcHash -eq $destHash)
    } catch {
        return $false
    }
}

# ─── Step 1: Verify packet checksums ─────────────────────────────────────────

$checkFile = Join-Path $PacketRoot 'CHECKSUMS.txt'
if (-not (Test-Path -LiteralPath $checkFile)) {
    Write-Output 'ERROR: packet damaged or incomplete; download it again'
    exit 2
}
$checkLines = Get-Content -LiteralPath $checkFile | Where-Object { $_ -match '\S' }
foreach ($line in $checkLines) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
    $expectHash = $Matches[1]
    $relPath    = $Matches[2]
    $fullPath   = Join-Path $PacketRoot ($relPath -replace '/','\')
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Write-Output "ERROR: packet damaged or incomplete; download it again ($relPath missing)"
        exit 2
    }
    if ((Get-Sha256 -Path $fullPath) -ne $expectHash) {
        Write-Output "ERROR: packet damaged or incomplete; download it again ($relPath hash mismatch)"
        exit 2
    }
}
Write-Output "Packet OK: $($checkLines.Count) files verified."

# ─── Step 2: Detect tools ─────────────────────────────────────────────────────

foreach ($keyName in @('ANTHROPIC_API_KEY','OPENAI_API_KEY','CURSOR_API_KEY','XAI_API_KEY','MUSE_API_KEY')) {
    if ([System.Environment]::GetEnvironmentVariable($keyName)) {
        Write-Output "WARNING: $keyName is set in the environment. API keys are banned; please remove it."
    }
}

$claudeCmd  = Get-Command 'claude'        -ErrorAction SilentlyContinue
$nodeCmd    = Get-Command 'node'          -ErrorAction SilentlyContinue
$codexCmd   = Get-Command 'codex'         -ErrorAction SilentlyContinue
$cursorCmd  = Get-Command 'cursor-agent'  -ErrorAction SilentlyContinue
$museCmd    = Get-Command 'muse'          -ErrorAction SilentlyContinue

$claudeVersion = Get-ToolVersion -Name 'claude'
$nodeVersion   = Get-ToolVersion -Name 'node'
$codexVersion  = Get-ToolVersion -Name 'codex'
$cursorVersion = Get-ToolVersion -Name 'cursor-agent'
$museVersion   = Get-ToolVersion -Name 'muse'

$hasClaude       = $null -ne $claudeCmd
$claudeVersionOk = $hasClaude -and (Compare-SemVer $claudeVersion '2.1.248') -ge 0
$nodeVersionOk   = ($null -ne $nodeVersion) -and ((Get-NodeMajor $nodeVersion) -ge 18)
$hasCodex        = $null -ne $codexVersion
$hasCursor       = $null -ne $cursorVersion
$hasMuse         = $null -ne $museVersion
if (-not $Uninstall -and -not $SelfTest -and -not ($hasClaude -or $hasCodex -or $hasCursor -or $hasMuse)) {
    Write-Output 'No supported agent tool found (Claude Code, Codex, Cursor Agent or Muse). Install one, log in, then run the installer again.'
    exit 2
}

Write-Output 'Tools:'
Write-Output "  Claude Code:  $(if (-not $hasClaude) {'not found'} else { $claudeVersion + $(if ($claudeVersionOk) {' (seat-eligible)'} else {' (too old for seats; need 2.1.248)'}) })"
Write-Output "  node:         $(if ($null -eq $nodeVersion) {'not found'} else { $nodeVersion + $(if ($nodeVersionOk) {' (OK)'} else {' (need 18+)'}) })"
Write-Output "  codex:        $(if ($null -eq $codexVersion) {'not found'} else {$codexVersion})"
Write-Output "  cursor-agent: $(if ($null -eq $cursorVersion) {'not found'} else {$cursorVersion})"
Write-Output "  muse:         $(if ($null -eq $museVersion) {'not found'} else {$museVersion})"

# ─── Resolve TargetRoot ───────────────────────────────────────────────────────

if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    $TargetRoot = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($TargetRoot)) { $TargetRoot = $env:HOME }
}
$CanonicalHome = Get-CanonicalPath -Path $TargetRoot
$HomeDir       = $CanonicalHome   # alias used throughout

# Muse's contributor tier (Meta may use what it is sent to train its models) is banned for team work. Say so when this
# machine's own Muse setting is on (read only; never changed). The summary says again whether the Muse relay installed
# here really forces it off for its jobs: a relay kept from before or installed by the person may not.
# Muse reads XDG_CONFIG_HOME when it is set (the Muse relay does the same); that applies to this user's own home only.
$MuseConfigBase = Join-Path $HomeDir '.config'
if ($env:XDG_CONFIG_HOME -and $env:USERPROFILE) {
    $ownHome = $null
    try { $ownHome = Get-CanonicalPath -Path $env:USERPROFILE } catch { $ownHome = $null }
    if ($ownHome -and ($ownHome -eq $HomeDir)) { $MuseConfigBase = $env:XDG_CONFIG_HOME }
}
$MuseSettingsFile  = Join-Path $MuseConfigBase 'muse\settings.json'
$MuseContributorOn = $false
if (Test-Path -LiteralPath $MuseSettingsFile -PathType Leaf) {
    $museSettingsText = ''
    try { $museSettingsText = [System.IO.File]::ReadAllText($MuseSettingsFile) } catch { $museSettingsText = '' }
    if ($museSettingsText -match '"contributor_mode_enabled"\s*:\s*true') {
        $MuseContributorOn = $true
        Write-Output "WARNING: Muse contributor mode is ON in ${MuseSettingsFile}: Meta may use what Muse is sent to train its models, which is banned for team work. Switch it off in Muse (set ""contributor_mode_enabled"": false)."
    }
}

# ─── Target paths ─────────────────────────────────────────────────────────────

$PolicyDir               = Join-Path $HomeDir '.config\delegate-skills\team-policy'
$PolicyMd                = Join-Path $PolicyDir 'POLICY.md'
$ProfileMd               = Join-Path $PolicyDir 'profiles\team.md'
$AgentsDir               = Join-Path $HomeDir '.claude\agents'
$ClaudeMd                = Join-Path $HomeDir '.claude\CLAUDE.md'
$CodexAgentsFile         = Join-Path $HomeDir '.codex\AGENTS.md'
$RuntimeDir              = Join-Path $HomeDir '.config\delegate-skills\consensus'
$LocalJsonPath           = Join-Path $RuntimeDir 'local.json'
$LedgerDir               = Join-Path $HomeDir '.config\delegate-skills\consensus-ledger'
$LanesFile               = Join-Path $HomeDir '.config\delegate-skills\config.json'
$SettingsFile            = Join-Path $HomeDir '.config\delegate-skills\team-settings.json'
$ReceiptFile             = Join-Path $HomeDir '.config\delegate-skills\team-install.json'
$FrontdeskDir            = Join-Path $HomeDir '.config\delegate-skills\frontdesk'
$FrontdeskReceipt        = Join-Path $HomeDir '.config\delegate-skills\frontdesk-install.json'
$BackupBase              = Join-Path $HomeDir '.config\delegate-skills\.backups\team'
$SkillConsensusClaudeDir = Join-Path $HomeDir '.claude\skills\consensus'
$SkillConsensusAgentsDir = Join-Path $HomeDir '.agents\skills\consensus'

# Relay directory roots (used for owned-and-inside checks)
$RelayRoots = @(
    (Join-Path $HomeDir '.claude\skills\codex-delegate'),
    (Join-Path $HomeDir '.claude\skills\cursor-delegate'),
    (Join-Path $HomeDir '.claude\skills\muse-delegate'),
    (Join-Path $HomeDir '.claude\skills\delegate-setup')
)

# ─── Step 16: Self-test (early exit) ─────────────────────────────────────────

if ($SelfTest) {
    if (-not $nodeVersionOk) {
        Write-Output 'Self-test: Node 18+ not found; skipping suite tests.'
        exit 0
    }
    $allPass = $true
    $failedSuites = New-Object System.Collections.ArrayList

    foreach ($suiteInfo in @(
        @{ Dir = (Join-Path $PacketRoot 'consensus'); Name = 'consensus' },
        @{ Dir = (Join-Path $PacketRoot 'setup');     Name = 'setup'     }
    )) {
        $sDir  = $suiteInfo['Dir']
        $sName = $suiteInfo['Name']
        if (-not (Test-Path -LiteralPath $sDir -PathType Container)) {
            Write-Output "Self-test: $sName/ not found in packet; FAIL"
            $allPass = $false
            [void]$failedSuites.Add($sName)
            continue
        }
        $tmpLedger = Join-Path ([System.IO.Path]::GetTempPath()) ('cst-' + [System.Guid]::NewGuid().ToString('N'))
        Ensure-Dir -Path $tmpLedger
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName             = $nodeCmd.Source
            $psi.Arguments            = '--test'
            $psi.WorkingDirectory     = $sDir
            $psi.UseShellExecute      = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError  = $true
            $psi.EnvironmentVariables['CONSENSUS_LEDGER'] = $tmpLedger
            $p = [System.Diagnostics.Process]::Start($psi)
            $stdoutTask = $p.StandardOutput.ReadToEndAsync()
            $stderrTask = $p.StandardError.ReadToEndAsync()
            $p.WaitForExit() | Out-Null
            $out = $stdoutTask.Result + $stderrTask.Result
            Write-Output "Suite: $sName"
            # Counts as "# tests 67" (TAP, older Node) or "(info sign) tests 67" (spec reporter, newer Node).
            $out -split "`n" | ForEach-Object { if ($_ -match '^\s*(\S+\s+)?(tests|pass|fail)\s+(\d+)\s*$') { Write-Output "  $($Matches[2]) $($Matches[3])" } }
            if ($p.ExitCode -ne 0) {
                $allPass = $false
                [void]$failedSuites.Add($sName)
            }
        } catch {
            Write-Output "Self-test: $sName/ could not run: $($_.Exception.Message)"
            $allPass = $false
            [void]$failedSuites.Add($sName)
        } finally {
            Remove-Item -LiteralPath $tmpLedger -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $installedReferee = Join-Path $RuntimeDir 'referee.mjs'
    if (Test-Path -LiteralPath $installedReferee) {
        Write-Output ''
        Write-Output 'Running doctor --human on installed runtime:'
        $tmpDoc = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.txt')
        try {
            $psi2 = New-Object System.Diagnostics.ProcessStartInfo
            $psi2.FileName  = 'cmd.exe'
            $psi2.Arguments = '/d /s /c "node "' + $installedReferee + '" doctor --human > "' + $tmpDoc + '" 2>&1"'
            $psi2.CreateNoWindow    = $true
            $psi2.UseShellExecute   = $false
            $p2 = [System.Diagnostics.Process]::Start($psi2)
            $p2.WaitForExit() | Out-Null
            if (Test-Path -LiteralPath $tmpDoc) { Get-Content -LiteralPath $tmpDoc | ForEach-Object { Write-Output $_ } }
        } finally {
            Remove-Item -LiteralPath $tmpDoc -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not $allPass) {
        Write-Output "Self-test FAILED: $($failedSuites -join ', ')"
        exit 1
    }
    Write-Output 'Self-test: all suites passed.'
    exit 0
}

# ─── Step 15: Uninstall (early exit) ─────────────────────────────────────────

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $ReceiptFile)) {
        Write-Output 'ERROR: nothing to uninstall (receipt not found)'
        exit 2
    }
    $receipt = (Read-Utf8 -Path $ReceiptFile) | ConvertFrom-Json

    # Ownership check: only a receipt whose home, made canonical, is this home may remove anything.
    if (-not ($receipt.PSObject.Properties['home'] -and -not [string]::IsNullOrWhiteSpace($receipt.home))) {
        Write-Output 'ERROR: the receipt names no home; nothing removed'
        exit 2
    }
    $recCanonHome = Get-CanonicalPath -Path $receipt.home
    if ($recCanonHome -ne $CanonicalHome) {
        Write-Output "ERROR: the receipt belongs to $($receipt.home); nothing removed"
        exit 2
    }

    Write-Output "Uninstalling delegation team packet (installed $($receipt.installedAt))..."
    Initialize-CodexSection -Previous $receipt -ForUninstall
    if ($CodexAction -in @('SKIP','KEEP')) { Write-Output "  $CodexAction ($CodexReason): $CodexAgentsFile (delegation section)" }
    $modified = New-Object System.Collections.ArrayList
    $deleted  = New-Object System.Collections.ArrayList

    foreach ($prop in $receipt.files.PSObject.Properties) {
        $fp   = $prop.Name
        $hash = $prop.Value
        if ($fp -ieq $ClaudeMd -or $fp -ieq $CodexAgentsFile) { continue }
        # Only touch owned-and-inside paths
        $canonFp = Get-CanonicalPath -Path $fp
        if (-not (Test-OwnedAndInside -CanonPath $canonFp -HomeCanon $CanonicalHome)) {
            Write-Output "  SKIP (outside owned folders): $fp"
            continue
        }
        if (-not (Test-Path -LiteralPath $fp -PathType Leaf)) { continue }
        $cur = Get-Sha256 -Path $fp
        if ($cur -eq $hash) {
            Remove-Item -LiteralPath $fp -Force
            [void]$deleted.Add($fp)
        } else {
            Write-Output "  MODIFIED (left in place): $fp"
            [void]$modified.Add($fp)
        }
    }

    # Remove CLAUDE.md delegation section
    if ($receipt.files.PSObject.Properties[$ClaudeMd] -and (Test-Path -LiteralPath $ClaudeMd)) {
        Invoke-ClaudeMdSplice -Path $ClaudeMd -NewSection '' -IsUninstall $true
        Write-Output '  Removed delegation section from CLAUDE.md'
    }

    Write-CodexSection -ForUninstall

    # Remove owned dirs bottom-up
    $ownedDirList  = New-Object System.Collections.Generic.List[string]
    $ownedRootsU = New-Object System.Collections.Generic.List[string]
    foreach ($r in @($RuntimeDir, $PolicyDir, $SkillConsensusClaudeDir, $SkillConsensusAgentsDir)) {
        [void]$ownedRootsU.Add($r)
    }
    foreach ($rd in $RelayRoots) { [void]$ownedRootsU.Add($rd) }
    foreach ($r in $ownedRootsU) {
        if (-not (Test-Path -LiteralPath $r -PathType Container)) { continue }
        Get-ChildItem -LiteralPath $r -Recurse -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { [void]$ownedDirList.Add($_.FullName) }
        [void]$ownedDirList.Add($r)
    }
    foreach ($d in @($ownedDirList | Sort-Object { $_.Length } -Descending)) {
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
        # A folder reached through a link that leads outside the owned locations is never touched.
        if (-not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath -Path $d) -HomeCanon $CanonicalHome)) { continue }
        $dItem = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
        if ($null -ne $dItem -and ($dItem.LinkType -eq 'Junction' -or $dItem.LinkType -eq 'SymbolicLink')) { continue }
        if (@(Get-ChildItem -LiteralPath $d -Recurse -File).Count -eq 0) {
            Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
        } else {
            Write-Output "  KEPT (modified files remain): $($d.Substring($HomeDir.Length).TrimStart('\','/'))"
        }
    }

    $ownsLadder = $receipt.PSObject.Properties['ladder'] -and $null -ne $receipt.ladder -and
        $receipt.ladder.PSObject.Properties['owned'] -and $receipt.ladder.owned -is [bool] -and $receipt.ladder.owned -eq $true
    if (-not $ownsLadder) {
        Write-Output '  Ladder: KEEP (not owned by this packet)'
    } elseif (-not (Test-LadderContainment)) {
        Write-Output '  Ladder: KEEP (a link leads outside the owned folders)'
    } elseif ((Get-Item -LiteralPath $FrontdeskReceipt -Force -ErrorAction SilentlyContinue) -and $null -eq (Get-TeamFrontdeskReceipt)) {
        Write-Output '  Ladder: KEEP (front desk receipt is unreadable or belongs to another install, or has hooks)'
    } else {
        Remove-LadderTree $FrontdeskDir
        Remove-LadderTree $FrontdeskReceipt
        Write-Output '  Ladder: removed packet-owned front desk and receipt'
    }
    Remove-Item -LiteralPath $ReceiptFile -Force
    Write-Output "Uninstall complete. $($deleted.Count) file(s) removed. Backups kept at $BackupBase"
    if ($modified.Count -gt 0) { Write-Output "  $($modified.Count) file(s) were modified and left in place." }
    exit 0
}

# ─── Packet version ───────────────────────────────────────────────────────────

$PacketVersion = (Get-Content -LiteralPath (Join-Path $PacketRoot 'VERSION') -Raw).Trim()
$RefereePath   = Join-Path $RuntimeDir 'referee.mjs'

# The control files (receipt, settings, backup folder) must not lead outside the owned locations
# through a link: stop before any change if one does.
foreach ($controlPath in @($ReceiptFile, $SettingsFile, $BackupBase, $LedgerDir)) {
    if (-not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath -Path $controlPath) -HomeCanon $CanonicalHome)) {
        Write-Output "ERROR: $controlPath leads outside the installer's folders through a link; remove that link and run again"
        exit 2
    }
}

# ─── Step 3: Read previous receipt ───────────────────────────────────────────

$prevReceipt       = $null
$prevPacketVersion = $null

if (Test-Path -LiteralPath $ReceiptFile -PathType Leaf) {
    try {
        $r = (Read-Utf8 -Path $ReceiptFile) | ConvertFrom-Json
        if ($r.PSObject.Properties['home'] -and -not [string]::IsNullOrWhiteSpace($r.home)) {
            $prevCanonHome = Get-CanonicalPath -Path $r.home
            if ($prevCanonHome -ne $CanonicalHome) {
                Write-Output "the receipt at $ReceiptFile belongs to $($r.home); ignored"
            } else {
                if ($r.PSObject.Properties['packetVersion'] -and -not [string]::IsNullOrWhiteSpace($r.packetVersion)) {
                    $prevPacketVersion = $r.packetVersion
                    $cmp = Compare-PacketVersion -A $r.packetVersion -B $PacketVersion
                    if ($cmp -gt 0 -and -not $AllowDowngrade) {
                        Write-Output "A newer packet ($($r.packetVersion)) is installed; this one is $PacketVersion. Use the newer packet, or run again with --allow-downgrade."
                        exit 2
                    }
                }
                $prevReceipt = $r
            }
        } else {
            # Without a home the receipt proves no ownership: no pruning, no recovery from it.
            Write-Output "the receipt at $ReceiptFile names no home; ignored"
        }
    } catch {
        Write-Output "WARNING: receipt at $ReceiptFile could not be read; treating as absent"
    }
}

# ─── Step 4: Settings ─────────────────────────────────────────────────────────

$hostMode = 'desktop'
if ($requestedMode) {
    $hostMode = $requestedMode
} elseif ($null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['hostMode'] -and
          $prevReceipt.hostMode -cin @('desktop', 'server')) {
    $hostMode = $prevReceipt.hostMode
}
$modeDescription = if ($hostMode -eq 'server') {
    'server (no person in the chat; follow "Desktop mode and server mode" in POLICY.md)'
} else {
    'desktop (a person works in the chat)'
}

$unavailableList = @()

if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
    # The whole document must be exactly {"unavailable":[ids]} (whitespace allowed between
    # tokens, none inside a string); anything else is unreadable, so no exclusion is ever lost
    # silently. install.sh applies the same rule.
    $settingsParsed = $false
    try {
        $raw = (Read-Utf8 -Path $SettingsFile).TrimStart([char]0xFEFF)
        $spaced = @([regex]::Matches($raw, '"[^"]*"') | Where-Object { $_.Value -match '\s' }).Count -gt 0
        $compact = $raw -replace '\s', ''
        if (-not $spaced -and $compact -match '^\{"unavailable":\[("[A-Za-z0-9._-]+"(,"[A-Za-z0-9._-]+")*)?\]\}$') {
            $inner = $compact.Substring(16, $compact.Length - 18)
            $unavailableList = @($inner -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { $_.Trim('"') })
            $settingsParsed = $true
        }
    } catch {
        $settingsParsed = $false
    }
    if (-not $settingsParsed -and -not $ClearUnavailable) {
        Write-Output 'ERROR: team-settings.json could not be read; fix or delete it, or run again with --clear-unavailable to reset the list of unavailable models'
        exit 2
    }
} elseif ($null -ne $prevReceipt -and
          $prevReceipt.PSObject.Properties['schema'] -and $prevReceipt.schema -eq 2 -and
          $prevReceipt.PSObject.Properties['unavailable'] -and $prevReceipt.unavailable.Count -gt 0) {
    $unavailableList = @($prevReceipt.unavailable)
    Write-Output "Recovered the unavailable models from the previous install: $($unavailableList -join ', ')"
}

if ($ClearUnavailable) { $unavailableList = @() }
if (-not [string]::IsNullOrWhiteSpace($Unavailable)) {
    $newIds = $Unavailable -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9._-]+$' }
    $unavailableList = @($unavailableList + $newIds)
}
$unavailableList = @($unavailableList | Sort-Object -Unique)

$settingsIsTarget = $unavailableList.Count -gt 0
$settingsRemove   = $ClearUnavailable -and ($unavailableList.Count -eq 0)

# Write settings to temp file for machine check input
$settingsTempPath = Join-Path ([System.IO.Path]::GetTempPath()) ('team-settings-' + [System.Guid]::NewGuid().ToString('N') + '.json')
if ($unavailableList.Count -gt 0) {
    $settingsJson = '{"unavailable":[' + (($unavailableList | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']}'
} else {
    $settingsJson = '{"unavailable":[]}'
}
Write-Utf8NoBom -Path $settingsTempPath -Text $settingsJson

# ─── Step 5: Machine check ────────────────────────────────────────────────────

$reposArg = $Repos
if ([string]::IsNullOrWhiteSpace($reposArg) -and $null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['repos'] -and
    $null -ne $prevReceipt.repos -and $prevReceipt.repos.PSObject.Properties['path']) {
    $reposArg = [string]$prevReceipt.repos.path
}
$checkReposText = $null
$checkToolsText = $null


# Resolve private folder locations before rendering either agent's entry section.
function Get-FolderPath {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { return $full.TrimEnd('\','/') }
    return $full
}

function Invoke-FolderTool {
    param([string[]]$Arguments)
    # Windows PowerShell 5.1's native splatting loses a trailing backslash in a quoted argument.
    # Quote for CommandLineToArgvW explicitly, including backslashes before quotes and at the end.
    $quoted = foreach ($arg in (@((Join-Path $PacketRoot 'setup\folders.mjs')) + $Arguments)) {
        '"' + [regex]::Replace([regex]::Replace($arg, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeCmd.Source; $psi.Arguments = $quoted -join ' '
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($psi)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw ('Folder tool failed: ' + $stderr.Result.Trim()) }
    } finally { $process.Dispose() }
}

$folderDir = Join-Path ([IO.Path]::GetTempPath()) ('team-folders-' + [Guid]::NewGuid().ToString('N'))
Ensure-Dir $folderDir
$folderFile = Join-Path $folderDir 'decided.json'
$folderArgs = @('find', '--home', $CanonicalHome, '--out', $folderFile)
if ($reposArg) { $folderArgs += @('--repos', $reposArg) }
$folderData = [ordered]@{ credentials = $null; knowledge = $null; searchIncomplete = $false; advice = @() }
foreach ($kind in @('credentials','knowledge')) {
    $value = if ($kind -eq 'credentials') { $Credentials } else { $Knowledge }
    $source = 'set'
    if (-not $value -and $null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['folders'] -and
        $null -ne $prevReceipt.folders -and $prevReceipt.folders.PSObject.Properties[$kind] -and $null -ne $prevReceipt.folders.$kind) {
        $value = [string]$prevReceipt.folders.$kind.path; $source = 'kept'
    }
    $folderData[$kind] = [ordered]@{ path = $null; source = $null; candidates = @() }
    if ($value) {
        $folderArgs += @(('--' + $kind), $value, ('--' + $kind + '-from'), $source)
        if (Test-Path -LiteralPath $value -PathType Container) {
            $folderData[$kind].path = Get-FolderPath $value; $folderData[$kind].source = $source
        } elseif ($source -eq 'set') { $folderData.advice += "The folder given with --$kind does not exist: $value." }
        else { $folderData.advice += "The remembered $kind folder $value no longer exists; folder search needs Node 18+." }
    }
}
try {
    if ($nodeVersionOk) {
        Invoke-FolderTool -Arguments $folderArgs
        $folderData = (Read-Utf8 $folderFile) | ConvertFrom-Json
    }
    $folderInteractive = -not $Yes -and -not $DryRun -and -not [Console]::IsInputRedirected -and [Environment]::UserInteractive
    foreach ($kind in @('credentials','knowledge')) {
        $f = $folderData.$kind
        if (-not $f.path -and $folderInteractive) {
            Write-Output "Choose the $kind folder:"
            $n = 0
            foreach ($c in $f.candidates) { $n++; Write-Output ("  {0}. {1}" -f $n, $c.path) }
            for ($try = 0; $try -lt 3; $try++) {
                Write-Host 'Type a number, a folder path, or press Enter to skip: ' -NoNewline
                $answer = Read-Host
                if (-not $answer) { break }
                $number = 0
                if ([int]::TryParse($answer, [ref]$number) -and $number -gt 0 -and $number -le @($f.candidates).Count) { $answer = $f.candidates[$number - 1].path }
                if (Test-Path -LiteralPath $answer -PathType Container) { $f.path = Get-FolderPath $answer; $f.source = 'asked'; break }
                Write-Output 'That folder does not exist.'
            }
        }
    }
    Write-Utf8NoBom $folderFile ($folderData | ConvertTo-Json -Depth 10)
    if ($nodeVersionOk) {
        Invoke-FolderTool -Arguments @('render','--decided',$folderFile,'--out',$folderDir)
        $foldersText = (Read-Utf8 (Join-Path $folderDir 'folders.md')).TrimEnd("`n")
        $foldersSection = (Read-Utf8 (Join-Path $folderDir 'folders-section.md')).TrimEnd("`n")
        $foldersSummary = @((Read-Utf8 (Join-Path $folderDir 'folders-summary.txt')) -split "`n" | Where-Object { $_ })
    } else {
        $profileLines = @(); $sectionLines = @(); $foldersSummary = @()
        foreach ($kind in @('credentials','knowledge')) {
            $f = $folderData.$kind
            $label = if ($kind -eq 'credentials') { 'Credentials folder' } else { 'Knowledge base (SecondBrain repository)' }
            $sectionLabel = if ($kind -eq 'credentials') { 'Credentials folder' } else { 'Knowledge base (the SecondBrain repository)' }
            $summaryLabel = if ($kind -eq 'credentials') { 'Credentials folder' } else { 'Knowledge base' }
            if ($f.path) {
                $how = if ($f.source -eq 'set') { "set with --$kind" } elseif ($f.source -eq 'asked') { 'chosen by you' } else { 'kept from the last run' }
                $profileLines += ('- {0}: `{1}` ({2})' -f $label, $f.path, $how)
                $shown = $f.path -replace '\\','/'
                if ($kind -eq 'credentials') {
                    $sectionLines += ('- {0}: `{1}`. The person''s logins, keys and account details;' -f $sectionLabel, $shown) + "`n  use it when a task needs them."
                } else {
                    $sectionLines += ('- {0}: `{1}`. Look there for project and background' -f $sectionLabel, $shown) + "`n  knowledge before asking the person."
                }
                $foldersSummary += "${summaryLabel}: $($f.path) ($how)"
            } else {
                $profileLines += "- ${label}: not set; run this installer with --$kind <folder> to set it"
                $sectionLines += ('- {0}: not set. Ask the person once where it is, then run' -f $sectionLabel) + "`n" + ('  the packet installer again with `--{0} <folder>` so every later chat has it.' -f $kind)
                $foldersSummary += "${summaryLabel}: not set"
            }
        }
        $foldersText = $profileLines -join "`n"
        $foldersSection = 'Your folders (remembered by the packet installer and kept on every later run; to change one, run the' + "`n" + 'installer again with `--credentials <folder>` or `--knowledge <folder>`):' + "`n`n" + ($sectionLines -join "`n")
        $foldersSummary += $folderData.advice
    }
    $receiptFolders = [ordered]@{}
    foreach ($kind in @('credentials','knowledge')) {
        $f = $folderData.$kind
        $receiptFolders[$kind] = if ($f.path) { [ordered]@{ path = $f.path; source = $f.source } } else { $null }
    }
} finally { Remove-Item -LiteralPath $folderDir -Recurse -Force }

Initialize-CodexSection -Previous $prevReceipt
$entryText = Get-EntryText

$checkOutDir       = $null
$checkSuccess      = $false
$checkFailReason   = ''
$checkRoutesText   = $null
$checkLanesText    = $null
$checkConsensusText = $null
$checkConsensusFirst = ''
$checkSummaryLines = @()
$checkLocalJsonBytes  = $null
$checkLanesJsonBytes  = $null
$checkReceiptJson  = $null

if ($nodeVersionOk) {
    $resolveMjs = Join-Path $PacketRoot 'setup\resolve.mjs'
    if (Test-Path -LiteralPath $resolveMjs -PathType Leaf) {
        $checkOutDir = Join-Path ([System.IO.Path]::GetTempPath()) ('team-check-' + [System.Guid]::NewGuid().ToString('N'))
        Ensure-Dir -Path $checkOutDir
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName  = $nodeCmd.Source
            $psi.Arguments = '"' + $resolveMjs + '" --packet "' + $PacketRoot + '" --home "' + $CanonicalHome + '" --settings "' + $settingsTempPath + '" --out "' + $checkOutDir + '" --mode ' + $hostMode
            if (-not [string]::IsNullOrWhiteSpace($reposArg)) { $psi.Arguments += ' --repos "' + $reposArg.TrimEnd('\') + '"' }
            $psi.UseShellExecute        = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError  = $true
            $psi.CreateNoWindow         = $true

            $psi.EnvironmentVariables['TEAM_CLAUDE']          = if ($null -ne $claudeCmd)  { $claudeCmd.Source  } else { '' }
            $psi.EnvironmentVariables['TEAM_CODEX']           = if ($null -ne $codexCmd)   { $codexCmd.Source   } else { '' }
            $psi.EnvironmentVariables['TEAM_CURSOR']          = if ($null -ne $cursorCmd)  { $cursorCmd.Source  } else { '' }
            $psi.EnvironmentVariables['TEAM_MUSE']            = if ($null -ne $museCmd)    { $museCmd.Source    } else { '' }
            $psi.EnvironmentVariables['TEAM_CLAUDE_VERSION']  = Get-VersionXYZ $claudeVersion
            $psi.EnvironmentVariables['TEAM_CODEX_VERSION']   = if ($null -ne $codexVersion)  { Get-VersionXYZ $codexVersion  } else { '' }
            $psi.EnvironmentVariables['TEAM_CURSOR_VERSION']  = if ($null -ne $cursorVersion) { Get-VersionXYZ $cursorVersion } else { '' }
            $psi.EnvironmentVariables['TEAM_MUSE_VERSION']    = if ($null -ne $museVersion)   { Get-VersionXYZ $museVersion   } else { '' }

            $tfail = [System.Environment]::GetEnvironmentVariable('TEAM_SETUP_FAIL')
            $tskip = [System.Environment]::GetEnvironmentVariable('TEAM_SETUP_SKIP')
            if ($null -ne $tfail) { $psi.EnvironmentVariables['TEAM_SETUP_FAIL'] = $tfail }
            if ($null -ne $tskip) { $psi.EnvironmentVariables['TEAM_SETUP_SKIP'] = $tskip }

            $p = [System.Diagnostics.Process]::Start($psi)
            $stdoutTask = $p.StandardOutput.ReadToEndAsync()
            $stderrTask = $p.StandardError.ReadToEndAsync()
            $p.WaitForExit() | Out-Null
            $checkOutput = ($stdoutTask.Result + $stderrTask.Result).Trim()

            if ($p.ExitCode -eq 0) {
                $required = @('local.json','routes.md','lanes.md','consensus.md','summary.txt','receipt.json','repos.md','tools.md')
                # With a relay tool present the lane file is required too (as in install.sh).
                if ($hasCodex -or $hasCursor -or $hasMuse) { $required += 'lanes.json' }
                $missing  = @($required | Where-Object { -not (Test-Path (Join-Path $checkOutDir $_) -PathType Leaf) })
                if ($missing.Count -eq 0) {
                    $checkSuccess       = $true
                    $checkRoutesText    = ((Read-Utf8 (Join-Path $checkOutDir 'routes.md'))    -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n")
                    $checkLanesText     = ((Read-Utf8 (Join-Path $checkOutDir 'lanes.md'))     -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n")
                    $checkConsensusText = ((Read-Utf8 (Join-Path $checkOutDir 'consensus.md')) -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n")
                    $checkConsensusFirst = ($checkConsensusText -split "`n")[0]
                    $checkSummaryLines  = @(Get-Content (Join-Path $checkOutDir 'summary.txt'))
                    $checkLocalJsonBytes = [System.IO.File]::ReadAllBytes((Join-Path $checkOutDir 'local.json'))
                    $checkReceiptJson   = (Read-Utf8 (Join-Path $checkOutDir 'receipt.json')).Trim()
                    $checkReposText     = ((Read-Utf8 (Join-Path $checkOutDir 'repos.md'))     -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n")
                    $checkToolsText     = ((Read-Utf8 (Join-Path $checkOutDir 'tools.md'))     -replace "`r`n","`n" -replace "`r","`n").TrimEnd("`n")
                    $lanesJsonPath = Join-Path $checkOutDir 'lanes.json'
                    if (Test-Path $lanesJsonPath -PathType Leaf) {
                        $checkLanesJsonBytes = [System.IO.File]::ReadAllBytes($lanesJsonPath)
                    }
                } else {
                    $checkFailReason = "machine check output missing: $($missing -join ', ')"
                }
            } else {
                $checkFailReason = if ($checkOutput) { ($checkOutput -split "`n")[0].Trim() } else { 'machine check exited non-zero' }
            }
        } catch {
            $checkFailReason = $_.Exception.Message -replace "`r`n",' ' -replace "`n",' '
        }
    } else {
        $checkFailReason = 'resolve.mjs not found in packet'
    }
}

# ─── Step 6: Degraded mode ────────────────────────────────────────────────────

$isDegraded     = (-not $nodeVersionOk) -or (-not $checkSuccess)
$degradedReason = if (-not $nodeVersionOk) { 'needs Node 18+' } else { $checkFailReason }
$hasPrevInstall = $null -ne $prevReceipt

# Collect kept files from previous receipt (runtime/relay/lane/local.json only)
$keptFiles = [ordered]@{}   # absolute path -> old hash
$keptActionLabel = if (-not $nodeVersionOk) { 'KEEP (needs Node 18+)' } else { 'KEEP (machine check failed)' }

if ($isDegraded -and $hasPrevInstall) {
    foreach ($prop in $prevReceipt.files.PSObject.Properties) {
        $fp   = $prop.Name
        $hash = $prop.Value
        $canonFp = Get-CanonicalPath -Path $fp
        if (-not (Test-OwnedAndInside -CanonPath $canonFp -HomeCanon $CanonicalHome)) { continue }
        $inRuntime = $fp.ToLowerInvariant().StartsWith(($RuntimeDir + '\').ToLowerInvariant())
        $inRelay   = $RelayRoots | Where-Object { $fp.ToLowerInvariant().StartsWith(($_ + '\').ToLowerInvariant()) }
        $isLane    = $fp.ToLowerInvariant() -eq $LanesFile.ToLowerInvariant()
        # The consensus skill copies go with the runtime they describe, so they are kept with it.
        $inSkill   = $fp.ToLowerInvariant().StartsWith(($SkillConsensusClaudeDir + '\').ToLowerInvariant()) -or
                     $fp.ToLowerInvariant().StartsWith(($SkillConsensusAgentsDir + '\').ToLowerInvariant())
        if ($inRuntime -or $inRelay -or $isLane -or $inSkill) {
            $keptFiles[$fp] = $hash
        }
    }
}

# ─── Steps 7-8: Compute desired targets and prune ─────────────────────────────

# $desired: ordered hashtable  absolute-path -> @{ Bytes; Hash; Kind }
$desired = [ordered]@{}

function Add-Desired {
    param([string]$TgtPath, [string]$SrcPath, [string]$Kind)
    $b = [System.IO.File]::ReadAllBytes($SrcPath)
    $desired[$TgtPath] = @{ Bytes = $b; Hash = (Get-Sha256Bytes -Bytes $b); Kind = $Kind }
}
function Add-DesiredBytes {
    param([string]$TgtPath, [byte[]]$Bytes, [string]$Kind)
    $desired[$TgtPath] = @{ Bytes = $Bytes; Hash = (Get-Sha256Bytes -Bytes $Bytes); Kind = $Kind }
}

# Policy files
Add-Desired -TgtPath $PolicyMd  -SrcPath (Join-Path $PacketRoot 'policy\POLICY.md') -Kind 'copy'

# Sonnet helper set.
# The machine check's sonnet-helpers.txt decides when it ran and wrote it; otherwise the
# installer's own Claude Code version does (known and older than 2.1.284 -> the 4.6 copies).
$claudeXYZ = Get-VersionXYZ $claudeVersion
$installerSonnet46 = (-not [string]::IsNullOrWhiteSpace($claudeXYZ)) -and ((Compare-SemVer $claudeXYZ '2.1.284') -lt 0)
$sonnetSrcDir = 'claude\agents'
$sonnetHelpersFile = $null
if ($checkSuccess -and $null -ne $checkOutDir) {
    $sonnetHelpersFile = Join-Path $checkOutDir 'sonnet-helpers.txt'
}
if ($null -ne $sonnetHelpersFile -and (Test-Path -LiteralPath $sonnetHelpersFile -PathType Leaf)) {
    if ((((Read-Utf8 -Path $sonnetHelpersFile) -replace "`r`n","`n" -replace "`r","`n").Trim()) -eq '4.6') {
        $sonnetSrcDir = 'claude\agents\sonnet-4-6'
    }
} elseif ($installerSonnet46) {
    $sonnetSrcDir = 'claude\agents\sonnet-4-6'
}
$degradedSonnetLine = if ($installerSonnet46) {
    "- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here, because Claude Code $claudeXYZ is older than 2.1.284; update Claude Code and run this installer again for Sonnet 5.5"
} else {
    '- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available'
}

# Claude-specific files are kept when its CLI disappears, not pruned.
$claudeParts = @($ClaudeMd) + @('explore.md','implementer.md','researcher.md','verifier.md','haiku-helper.md' | ForEach-Object { Join-Path $AgentsDir $_ })
if (-not $hasClaude -and $null -ne $prevReceipt) {
    foreach ($prop in $prevReceipt.files.PSObject.Properties) {
        if ($claudeParts -contains $prop.Name -and (Test-OwnedAndInside -CanonPath (Get-CanonicalPath $prop.Name) -HomeCanon $CanonicalHome)) { $keptFiles[$prop.Name] = $prop.Value }
    }
}
# Agent files (only with Claude Code)
if ($hasClaude) {
foreach ($af in @('explore.md','implementer.md','researcher.md','verifier.md')) {
    $agSrc = Join-Path $PacketRoot "$sonnetSrcDir\$af"
    if (Test-Path -LiteralPath $agSrc) {
        Add-Desired -TgtPath (Join-Path $AgentsDir $af) -SrcPath $agSrc -Kind 'copy'
    }
}
foreach ($af in @('haiku-helper.md')) {
    $agSrc = Join-Path $PacketRoot "claude\agents\$af"
    if (Test-Path -LiteralPath $agSrc) {
        Add-Desired -TgtPath (Join-Path $AgentsDir $af) -SrcPath $agSrc -Kind 'copy'
    }
}
}

# Runtime consensus files and local settings
if ($checkSuccess) {
    Add-DesiredBytes -TgtPath $LocalJsonPath -Bytes $checkLocalJsonBytes -Kind 'check-output'
} elseif (Test-OwnedAndInside -CanonPath (Get-CanonicalPath -Path $LocalJsonPath) -HomeCanon $CanonicalHome) {
    $local = $null
    if ($hasPrevInstall -and (Test-Path -LiteralPath $LocalJsonPath -PathType Leaf)) {
        try {
            $existingLocal = (Read-Utf8 $LocalJsonPath) | ConvertFrom-Json
            if ($existingLocal -is [PSCustomObject]) {
                if (-not $existingLocal.PSObject.Properties['hostMode'] -or $existingLocal.hostMode -cne $hostMode) {
                    $existingLocal | Add-Member -NotePropertyName 'hostMode' -NotePropertyValue $hostMode -Force
                    $local = $existingLocal
                }
            }
        } catch {
            # Leave unreadable settings in place. The referee treats them as disabled.
        }
    } else {
        $reason = if ($nodeVersionOk) { "machine check failed: $checkFailReason" } else { $degradedReason }
        $local = [ordered]@{ hostMode = $hostMode; disabled = $reason; seats = @{} }
    }
    if ($null -ne $local) {
        $keptFiles.Remove($LocalJsonPath)
        $localText = ($local | ConvertTo-Json -Depth 100 -Compress) + "`n"
        Add-DesiredBytes -TgtPath $LocalJsonPath -Bytes $EncUtf8NoBom.GetBytes($localText) -Kind 'check-output'
    }
}

$hasRuntime = $false
if (-not $isDegraded) {
    # Successful check: install from the packet and add local.json from the check
    $conSrc = Join-Path $PacketRoot 'consensus'
    foreach ($f in (Get-ChildItem -LiteralPath $conSrc -Recurse -File)) {
        $rel    = $f.FullName.Substring($conSrc.Length).TrimStart('\','/')
        $topDir = ($rel -split '[\\\/]')[0]
        if ($topDir -eq 'tests' -or $topDir -eq 'skill' -or $rel -in @('BUILD-BRIEF.txt', 'local.json')) { continue }
        Add-Desired -TgtPath (Join-Path $RuntimeDir $rel) -SrcPath $f.FullName -Kind 'copy'
    }
    $hasRuntime = $true
} elseif (-not $nodeVersionOk) {
    # No Node: SKIP all runtime (handled in plan)
    $hasRuntime = $false
} else {
    # Check failed, fresh install: install runtime with disabled local.json
    if (-not $hasPrevInstall) {
        $conSrc = Join-Path $PacketRoot 'consensus'
        foreach ($f in (Get-ChildItem -LiteralPath $conSrc -Recurse -File)) {
            $rel    = $f.FullName.Substring($conSrc.Length).TrimStart('\','/')
            $topDir = ($rel -split '[\\\/]')[0]
            if ($topDir -eq 'tests' -or $topDir -eq 'skill' -or $rel -in @('BUILD-BRIEF.txt', 'local.json')) { continue }
            Add-Desired -TgtPath (Join-Path $RuntimeDir $rel) -SrcPath $f.FullName -Kind 'copy'
        }
        $hasRuntime = $true
    }
    # else: previous install kept (keptFiles), don't add to desired
}

# Consensus skill
$skillSrc  = Join-Path $PacketRoot 'consensus\skill\consensus\SKILL.md'
$skillText = $null
if (Test-Path -LiteralPath $skillSrc) { $skillText = Read-Utf8 -Path $skillSrc }

# Relay skills (only when check succeeded)
$RelayNames = New-Object System.Collections.ArrayList
$hasRelays  = $false
if (-not $isDegraded) {
    if ($hasCodex)  { [void]$RelayNames.Add('codex-delegate') }
    if ($hasCursor) { [void]$RelayNames.Add('cursor-delegate') }
    if ($hasMuse)   { [void]$RelayNames.Add('muse-delegate') }
    if ($RelayNames.Count -gt 0) {
        [void]$RelayNames.Add('delegate-setup')
        $hasRelays = $true
    }
    $prevFileKeys = @()
    if ($null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['files']) {
        $prevFileKeys = @($prevReceipt.files.PSObject.Properties | ForEach-Object { $_.Name.ToLowerInvariant() })
    }
    $KeptRelays = New-Object System.Collections.ArrayList
    foreach ($relayName in @($RelayNames)) {
        $relayDst = (Join-Path $HomeDir ".claude\skills\$relayName").ToLowerInvariant() + '\'
        $ownedByUs = @($prevFileKeys | Where-Object { $_.StartsWith($relayDst) }).Count -gt 0
        if ((Test-Path -LiteralPath $relayDst.TrimEnd('\') -PathType Container) -and -not $ownedByUs) {
            [void]$KeptRelays.Add($relayName)
            [void]$RelayNames.Remove($relayName)
        }
    }
    foreach ($relayName in $RelayNames) {
        $relaySrc = Join-Path $PacketRoot "skills\$relayName"
        if (-not (Test-Path -LiteralPath $relaySrc -PathType Container)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $relaySrc -Recurse -File)) {
            $rel = $f.FullName.Substring($relaySrc.Length).TrimStart('\','/')
            Add-Desired -TgtPath (Join-Path $HomeDir ".claude\skills\$relayName\$rel") -SrcPath $f.FullName -Kind 'relay-copy'
        }
    }
    # Use the check's lane choices whenever a relay is present (installed now or kept).
    if (($hasRelays -or $KeptRelays.Count -gt 0) -and $null -ne $checkLanesJsonBytes) {
        Add-DesiredBytes -TgtPath $LanesFile -Bytes $checkLanesJsonBytes -Kind 'check-output'
    }
}
if ($null -eq (Get-Variable -Name KeptRelays -ErrorAction SilentlyContinue)) { $KeptRelays = New-Object System.Collections.ArrayList }

# Settings file
if ($settingsIsTarget) {
    $settingsBytes = $EncUtf8NoBom.GetBytes($settingsJson)
    Add-DesiredBytes -TgtPath $SettingsFile -Bytes $settingsBytes -Kind 'settings'
}

# ─── Step 9: Render placeholders ─────────────────────────────────────────────

# Determine text values for {{ROUTES}}, {{LANES}}, {{CONSENSUS}}, {{REPOS}}, {{OTHER_TOOLS}}
if ($checkSuccess) {
    $reposText = $checkReposText
    $toolsText = $checkToolsText
} else {
    $reposText = if (-not [string]::IsNullOrWhiteSpace($reposArg)) { "- Repositories: $reposArg" } else { '- Repositories: not detected (the model check did not run)' }
    $toolsText = '- not checked (the model check did not run)'
}
if ($checkSuccess) {
    $routesText    = $checkRoutesText
    $lanesText     = $checkLanesText
    $consensusText = $checkConsensusText
} elseif (-not $nodeVersionOk) {
    $routesText    = "- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try; needs Claude Code 2.1.293 or newer`n$degradedSonnetLine"
    $lanesText     = '- none: the relays need Node 18+'
    $consensusText = 'off: no Node 18+'
} else {
    # check failed
    $routesText = "- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try; needs Claude Code 2.1.293 or newer`n$degradedSonnetLine"
    if ($hasPrevInstall) {
        $lanesText     = '- unchanged: the previous lanes are kept (machine check failed)'
        $consensusText = 'unchanged: the previous reviewer setup is kept (machine check failed)'
    } else {
        $lanesText     = "- none: the machine check failed"
        $consensusText = 'off: the machine check failed'
    }
}

Initialize-Ladder
if (-not $hasClaude -and -not $checkSuccess) { $routesText = '- No Claude Code helper routes: Claude Code is not found.' }
$renderVars = @{
    'ENTRY'           = $entryText
    'LADDER'          = Get-LadderProfileLine
    'SHARED_ROOT'     = ($PolicyDir   -replace '\\','/')
    'PROFILE'         = 'team'
    'REFEREE'         = ($RefereePath -replace '\\','/')
    'LEDGER'          = ($LedgerDir   -replace '\\','/')
    'DATE'            = [System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    'OS'              = 'Windows'
    'MODE'            = $modeDescription
    'HOME'            = ($HomeDir     -replace '\\','/')
    'PACKET_VERSION'  = $PacketVersion
    'CLAUDE_VERSION'  = if ($hasClaude) { $claudeVersion } else { 'not found' }
    'NODE_VERSION'    = if ($null -eq $nodeVersion) { 'not installed' } else { $nodeVersion }
    'CODEX_VERSION'   = if ($null -eq $codexVersion)  { 'not installed' } else { $codexVersion }
    'CURSOR_VERSION'  = if ($null -eq $cursorVersion) { 'not installed' } else { $cursorVersion }
    'MUSE_VERSION'    = if ($null -eq $museVersion)   { 'not installed' } else { $museVersion }
    'RUNTIME'         = ($RefereePath -replace '\\','/')
    'ROUTES'          = $routesText
    'LANES'           = $lanesText
    'CONSENSUS'       = $consensusText
    'REPOS'           = $reposText
    'FOLDERS'         = $foldersText
    'OTHER_TOOLS'     = $toolsText
}

$bootstrapSrc  = Join-Path $PacketRoot 'claude\CLAUDE-bootstrap.md'
$templateSrc   = Join-Path $PacketRoot 'policy\profiles\team.md.template'
$bootstrapVars = $renderVars.Clone(); $bootstrapVars['FOLDERS'] = $foldersSection
$bootstrapText = (Render-Text -Text (Read-Utf8 -Path $bootstrapSrc) -Vars $bootstrapVars) -replace "`r`n","`n"
$profileText   = Render-Text -Text (Read-Utf8 -Path $templateSrc)  -Vars $renderVars

if ($null -ne $skillText) {
    $skillText = Render-Text -Text $skillText -Vars $renderVars
}

foreach ($pair in @(@('CLAUDE-bootstrap.md', $bootstrapText), @('team.md.template', $profileText))) {
    if ($pair[1] -match '\{\{') {
        Write-Output "ERROR: unrendered placeholder in $($pair[0]): $($Matches[0])"
        exit 1
    }
}
if ($null -ne $skillText -and $skillText -match '\{\{[A-Z_]+\}\}') {
    Write-Output "ERROR: unrendered placeholder in SKILL.md: $($Matches[0])"
    exit 1
}

$bootstrapBytes = $EncUtf8NoBom.GetBytes($bootstrapText)
$profileBytes   = $EncUtf8NoBom.GetBytes($profileText)
$skillBytes     = if ($null -ne $skillText) { $EncUtf8NoBom.GetBytes($skillText) } else { $null }

# Add rendered files to desired
Add-DesiredBytes -TgtPath $ProfileMd -Bytes $profileBytes -Kind 'rendered'

if ($null -ne $skillBytes -and ($hasRuntime -or (-not $isDegraded))) {
    Add-DesiredBytes -TgtPath (Join-Path $SkillConsensusClaudeDir 'SKILL.md') -Bytes $skillBytes -Kind 'rendered'
    Add-DesiredBytes -TgtPath (Join-Path $SkillConsensusAgentsDir 'SKILL.md') -Bytes $skillBytes -Kind 'rendered'
}

# ─── Step 11: Build plan ─────────────────────────────────────────────────────

$planItems = New-Object System.Collections.ArrayList

function Add-Plan {
    param([string]$Label, [string]$TgtPath, [string]$Action, [string]$SkipReason = '')
    [void]$planItems.Add([PSCustomObject]@{ Label=$Label; TgtPath=$TgtPath; Action=$Action; SkipReason=$SkipReason })
}

$profileNormPrefix = 'Rendered by the delegation team packet installer on'
$profileDesiredPatch = $null

# A target reached through a link that leads outside the owned locations is never written.
$outsideTargets = @($desired.Keys | Where-Object { -not (Test-OwnedAndInside -CanonPath (Get-CanonicalPath -Path $_) -HomeCanon $CanonicalHome) })
foreach ($tp in $outsideTargets) {
    $desired.Remove($tp)
    Add-Plan -Label ($tp.Substring($HomeDir.Length).TrimStart('\','/')) -TgtPath '' -Action 'SKIP' -SkipReason 'a link leads outside the owned folders'
}

# Build plan for desired files
foreach ($kv in $desired.GetEnumerator()) {
    $tp    = $kv.Key
    $entry = $kv.Value
    $lbl   = $tp.Substring($HomeDir.Length).TrimStart('\','/')
    $cur   = Get-Sha256OrAbsent -Path $tp

    if ($cur -eq 'absent') {
        Add-Plan -Label $lbl -TgtPath $tp -Action 'CREATE'
    } elseif ($tp -eq $ProfileMd) {
        $desiredNorm = (($EncUtf8NoBom.GetString($entry.Bytes) -replace "`r`n","`n" -replace "`r","`n") -split "`n" |
            ForEach-Object { if ($_.StartsWith($profileNormPrefix)) { $profileNormPrefix } else { $_ } }) -join "`n"
        $currentText = ([System.IO.File]::ReadAllText($tp)) -replace "`r`n","`n" -replace "`r","`n"
        $desiredNorm = $desiredNorm -replace '(?m), set with --repos(?=\)$)',''
        $desiredNorm = $desiredNorm -replace '(?m)^(- (?:Credentials folder|Knowledge base \(SecondBrain repository\)): (.*)) \((?:found|set with --credentials|set with --knowledge|chosen by you|kept from the last run)\)$','$1'
        $currentNorm = ($currentText -split "`n" |
            ForEach-Object { if ($_.StartsWith($profileNormPrefix)) { $profileNormPrefix } else { $_ } }) -join "`n"
        $currentNorm = $currentNorm -replace '(?m), set with --repos(?=\)$)',''
        $currentNorm = $currentNorm -replace '(?m)^(- (?:Credentials folder|Knowledge base \(SecondBrain repository\)): (.*)) \((?:found|set with --credentials|set with --knowledge|chosen by you|kept from the last run)\)$','$1'
        if ($desiredNorm -eq $currentNorm) {
            $diskBytes = [System.IO.File]::ReadAllBytes($tp)
            $profileDesiredPatch = @{ Bytes = $diskBytes; Hash = (Get-Sha256Bytes -Bytes $diskBytes); Kind = $entry.Kind }
            Add-Plan -Label $lbl -TgtPath $tp -Action 'UNCHANGED'
        } else {
            Add-Plan -Label $lbl -TgtPath $tp -Action 'UPDATE'
        }
    } elseif ($cur -eq $entry.Hash) {
        Add-Plan -Label $lbl -TgtPath $tp -Action 'UNCHANGED'
    } else {
        Add-Plan -Label $lbl -TgtPath $tp -Action 'UPDATE'
    }
}
if ($null -ne $profileDesiredPatch) { $desired[$ProfileMd] = $profileDesiredPatch }

# KEEP items (degraded, from previous receipt)
foreach ($kv in $keptFiles.GetEnumerator()) {
    $fp   = $kv.Key
    $lbl  = $fp.Substring($HomeDir.Length).TrimStart('\','/')
    $keepReason = if (-not $hasClaude -and $fp -in $claudeParts) { 'Claude Code not found; left as installed' } else { $keptActionLabel -replace '^KEEP \((.+)\)$','$1' }
    Add-Plan -Label $lbl -TgtPath $fp -Action 'KEEP' -SkipReason $keepReason
}
if (-not $hasClaude) {
    foreach ($fp in @($ClaudeMd) + @('explore.md','implementer.md','researcher.md','verifier.md','haiku-helper.md' | ForEach-Object { Join-Path $AgentsDir $_ })) {
        if (-not $keptFiles.Contains($fp)) { Add-Plan -Label $fp.Substring($HomeDir.Length).TrimStart('\','/') -TgtPath $fp -Action 'SKIP' -SkipReason 'needs Claude Code' }
    }
}

# Prune: previous receipt files not in desired and not in keptFiles
$pruneRemove = New-Object System.Collections.ArrayList
$pruneKeep   = New-Object System.Collections.ArrayList
if ($null -ne $prevReceipt) {
    foreach ($prop in $prevReceipt.files.PSObject.Properties) {
        $fp   = $prop.Name
        $hash = $prop.Value
        if ($fp -ieq $ClaudeMd -or $fp -ieq $CodexAgentsFile) { continue }
        if ($desired.Contains($fp)) { continue }
        if ($keptFiles.Contains($fp)) { continue }
        if ($settingsRemove -and $fp -ieq $SettingsFile) { continue }   # handled below
        $canonFp = Get-CanonicalPath -Path $fp
        if (-not (Test-OwnedAndInside -CanonPath $canonFp -HomeCanon $CanonicalHome)) {
            Write-Output "  NOTE: $fp is outside the owned folders; ignored"
            continue
        }
        if (-not (Test-Path -LiteralPath $fp -PathType Leaf)) { continue }
        $lbl = $fp.Substring($HomeDir.Length).TrimStart('\','/')
        $cur = Get-Sha256 -Path $fp
        if ($cur -eq $hash) {
            Add-Plan -Label $lbl -TgtPath $fp -Action 'REMOVE'
            [void]$pruneRemove.Add($fp)
        } else {
            Add-Plan -Label $lbl -TgtPath $fp -Action 'KEEP' -SkipReason 'changed since install'
            [void]$pruneKeep.Add($fp)
        }
    }
}

# --clear-unavailable that leaves the list empty removes the settings file, even when it was
# changed or unreadable (it is backed up first, like every removal).
if ($settingsRemove -and (Test-Path -LiteralPath $SettingsFile -PathType Leaf) -and
    (Test-OwnedAndInside -CanonPath (Get-CanonicalPath -Path $SettingsFile) -HomeCanon $CanonicalHome)) {
    Add-Plan -Label ($SettingsFile.Substring($HomeDir.Length).TrimStart('\','/')) -TgtPath $SettingsFile -Action 'REMOVE'
    [void]$pruneRemove.Add($SettingsFile)
}

# CLAUDE.md
if ($hasClaude) {
$claudeMdLabel  = $ClaudeMd.Substring($HomeDir.Length).TrimStart('\','/')
$curSection     = Get-CurrentDelegationSection -Path $ClaudeMd
$renderedSection = $bootstrapText.TrimEnd("`n") + "`n"
if ($null -eq $curSection) {
    $claudeAction = 'CREATE'
} elseif (($curSection.TrimEnd("`n") + "`n") -eq $renderedSection) {
    $claudeAction = 'UNCHANGED'
} else {
    $claudeAction = 'UPDATE'
}
Add-Plan -Label "$claudeMdLabel (delegation section)" -TgtPath $ClaudeMd -Action $claudeAction
} else { $claudeAction = if ($keptFiles.Contains($ClaudeMd)) { 'KEEP' } else { 'SKIP' } }
Add-Plan -Label '.codex/AGENTS.md (delegation section)' -TgtPath $CodexAgentsFile -Action $CodexAction -SkipReason $CodexReason

# Relay folders this packet did not install are left as they are
foreach ($kr in $KeptRelays) {
    Add-Plan -Label ".claude/skills/$kr/" -TgtPath '' -Action 'KEEP' -SkipReason 'installed by you; not replaced'
}

# SKIP items
$skipReasonNode = if ($null -eq $nodeVersion) { 'needs Node 18+' } else { "needs Node 18+ (found $(Get-NodeMajor $nodeVersion))" }
$skipReasonCheck = "machine check failed: $checkFailReason"

if (-not $nodeVersionOk) {
    Add-Plan -Label '.config/delegate-skills/consensus/ (runtime)' -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonNode
    Add-Plan -Label '.claude/skills/consensus/SKILL.md'            -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonNode
    Add-Plan -Label '.agents/skills/consensus/SKILL.md'            -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonNode
    foreach ($rn in @('codex-delegate','cursor-delegate','muse-delegate','delegate-setup')) {
        Add-Plan -Label ".claude/skills/$rn/" -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonNode
    }
    Add-Plan -Label '.config/delegate-skills/config.json' -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonNode
} elseif ($isDegraded -and -not $hasPrevInstall) {
    # check failed, fresh: relays and lane SKIP
    foreach ($rn in @('codex-delegate','cursor-delegate','muse-delegate','delegate-setup')) {
        Add-Plan -Label ".claude/skills/$rn/" -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonCheck
    }
    Add-Plan -Label '.config/delegate-skills/config.json' -TgtPath '' -Action 'SKIP' -SkipReason $skipReasonCheck
} elseif (-not $isDegraded) {
    if (-not $hasCodex)  { Add-Plan -Label '.claude/skills/codex-delegate/'   -TgtPath '' -Action 'SKIP' -SkipReason 'codex not found' }
    if (-not $hasCursor) { Add-Plan -Label '.claude/skills/cursor-delegate/'  -TgtPath '' -Action 'SKIP' -SkipReason 'cursor-agent not found' }
    if (-not $hasMuse)   { Add-Plan -Label '.claude/skills/muse-delegate/'    -TgtPath '' -Action 'SKIP' -SkipReason 'muse not found' }
    if (-not $hasRelays) {
        Add-Plan -Label '.claude/skills/delegate-setup/'          -TgtPath '' -Action 'SKIP' -SkipReason 'no relay tools found'
        Add-Plan -Label '.config/delegate-skills/config.json'     -TgtPath '' -Action 'SKIP' -SkipReason 'no relay tools found'
    }
}

# ─── Print plan ───────────────────────────────────────────────────────────────

Write-Output ''
Write-Output '--- Plan ---'
Write-Output "Mode: $hostMode"
foreach ($item in $planItems) {
    switch ($item.Action) {
        'SKIP'   { Write-Output ("  SKIP ({0}): {1}"     -f $item.SkipReason, $item.Label) }
        'KEEP'   { Write-Output ("  KEEP ({0}): {1}"     -f $item.SkipReason, $item.Label) }
        'REMOVE' { Write-Output ("  REMOVE: {0}"          -f $item.Label) }
        default  { Write-Output ("  {0}: {1}"             -f $item.Action,    $item.Label) }
    }
}
Write-Output ''

# Version line
$prevPV = if ($null -ne $prevPacketVersion) { $prevPacketVersion } else { '' }
if ([string]::IsNullOrWhiteSpace($prevPV)) {
    Write-Output "New install of $PacketVersion"
} elseif ($prevPV -eq $PacketVersion) {
    Write-Output "Re-installing $PacketVersion"
} else {
    $vcmp = Compare-PacketVersion -A $prevPV -B $PacketVersion
    if ($vcmp -lt 0) {
        Write-Output "Upgrading from $prevPV to $PacketVersion"
    } else {
        Write-Output "Downgrading from $prevPV to $PacketVersion (allowed)"
    }
}
Write-Output ''

# Detected tools line
Write-Output "Tools: claude=$claudeVersion  node=$(if($null -eq $nodeVersion){'not found'}else{$nodeVersion})  codex=$(if($null -eq $codexVersion){'not found'}else{$codexVersion})  cursor-agent=$(if($null -eq $cursorVersion){'not found'}else{$cursorVersion})  muse=$(if($null -eq $museVersion){'not found'}else{$museVersion})"
Write-Output $entryText
if ($CodexReason -like 'CODEX_HOME points to*') { Write-Output ('Add the "## Delegation (shared rulebook)" section to "{0}/AGENTS.md" yourself, pointing at {1}/POLICY.md and profiles/team.md.' -f $env:CODEX_HOME, $PolicyDir) }

# Declared unavailable
if ($unavailableList.Count -gt 0) {
    Write-Output "Unavailable models: $($unavailableList -join ', ')"
}

# Machine check summary lines
foreach ($sl in $checkSummaryLines) { Write-Output "  $sl"; if ($sl -like 'Repositories:*') { $foldersSummary | ForEach-Object { Write-Output "  $_" } } }
if (-not $checkSuccess) { Write-Output ($reposText -replace '^- ',''); $foldersSummary | ForEach-Object { Write-Output "  $_" } }

if ($checkFailReason -and -not $checkSuccess -and $nodeVersionOk) {
    Write-Output "Machine check failed: $checkFailReason"
}

Write-Output ''

if ($DryRun) {
    Invoke-LadderInstall
    Write-Output 'Dry-run: no changes made.'
    exit 0
}

$hasChanges = @($planItems | Where-Object { $_.Action -eq 'CREATE' -or $_.Action -eq 'UPDATE' -or $_.Action -eq 'REMOVE' }).Count -gt 0
if (-not $hasChanges) {
    # Nothing to write, but the receipt still records this run's model check (refresh).
    Write-Output 'All targets already up to date; only the install record is refreshed.'
} elseif ($folderInteractive) {
    Write-Output 'Press Enter to install, or close this window to cancel.'
    $null = Read-Host
}

# ─── Step 12: Apply ──────────────────────────────────────────────────────────

$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $BackupBase $stamp
$sfx = 0
while (Test-Path -LiteralPath $backupDir) { $sfx++; $backupDir = Join-Path $BackupBase ("$stamp-$sfx") }

$anyBackup = $false

# Phase 1: Back up everything that will change or be removed - verify before writing
$backupFailed = $false
$toBackup = New-Object System.Collections.ArrayList

foreach ($kv in $desired.GetEnumerator()) {
    $tp   = $kv.Key
    $pi   = $planItems | Where-Object { $_.TgtPath -eq $tp } | Select-Object -First 1
    if ($null -ne $pi -and ($pi.Action -eq 'UPDATE') -and (Test-Path -LiteralPath $tp -PathType Leaf)) {
        [void]$toBackup.Add($tp)
    }
}
foreach ($fp in $pruneRemove) {
    if (Test-Path -LiteralPath $fp -PathType Leaf) { [void]$toBackup.Add($fp) }
}
if ($hasClaude -and $claudeAction -ne 'UNCHANGED' -and (Test-Path -LiteralPath $ClaudeMd -PathType Leaf)) {
    # Adding the section to an existing CLAUDE.md changes the person's file too, so back it up.
    [void]$toBackup.Add($ClaudeMd)
}
if ($CodexAction -eq 'UPDATE' -and $CodexSourceExists) { [void]$toBackup.Add($CodexAgentsFile) }

foreach ($fp in $toBackup) {
    $ok = Backup-File -FilePath $fp -HomeRoot $HomeDir -BackupDir $backupDir
    if (-not $ok) {
        Write-Output "ERROR: could not back up $fp; aborting before any change"
        exit 1
    }
    $anyBackup = $true
}

# Phase 2: Write desired files
foreach ($kv in $desired.GetEnumerator()) {
    $tp    = $kv.Key
    if ($tp -eq $ProfileMd) { continue } # Final ladder result is rendered after the core is written.
    $entry = $kv.Value
    $pi    = $planItems | Where-Object { $_.TgtPath -eq $tp } | Select-Object -First 1
    if ($null -eq $pi -or $pi.Action -eq 'UNCHANGED') { continue }
    Ensure-Dir -Path (Split-Path -Parent $tp)
    [System.IO.File]::WriteAllBytes($tp, $entry.Bytes)
}

# CLAUDE.md splice
if ($hasClaude -and $claudeAction -ne 'UNCHANGED') {
    Invoke-ClaudeMdSplice -Path $ClaudeMd -NewSection $renderedSection -IsUninstall $false
}
Write-CodexSection
$entryText = Get-EntryText
$renderVars['ENTRY'] = $entryText

# Delete REMOVE files
foreach ($fp in $pruneRemove) {
    if (Test-Path -LiteralPath $fp -PathType Leaf) {
        Remove-Item -LiteralPath $fp -Force
    }
}

# Remove empty owned folders bottom-up (from prune only, not entire dirs)
$foldersToCheck = New-Object System.Collections.Generic.List[string]
foreach ($fp in $pruneRemove) {
    $d = Split-Path -Parent $fp
    while ($d -and (Test-OwnedAndInside -CanonPath (Get-CanonicalPath $d) -HomeCanon $CanonicalHome)) {
        [void]$foldersToCheck.Add($d)
        $d = Split-Path -Parent $d
    }
}
foreach ($d in @($foldersToCheck | Sort-Object { $_.Length } -Descending | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
    $dItem = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
    if ($null -ne $dItem -and ($dItem.LinkType -eq 'Junction' -or $dItem.LinkType -eq 'SymbolicLink')) { continue }
    if (@(Get-ChildItem -LiteralPath $d -Recurse -File).Count -eq 0) {
        Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
    }
}

# Ensure ledger dir
if ($hasRuntime) { Ensure-Dir -Path $LedgerDir }

if ($anyBackup) { Write-Output "Backups written to: $backupDir" }

# Post-write hash verification
Invoke-LadderInstall
if ($desired.Contains($ProfileMd)) {
    $renderVars['LADDER'] = Get-LadderProfileLine
    $finalProfile = Render-Text -Text (Read-Utf8 $templateSrc) -Vars $renderVars
    if ($finalProfile.Contains('{{')) { throw 'Unrendered placeholder in team profile' }
    $currentProfile = if (Test-Path -LiteralPath $ProfileMd -PathType Leaf) { Read-Utf8 $ProfileMd } else { '' }
    $normPattern = '(?m)^Rendered by the delegation team packet installer on[^\r\n]*|(?<=`) \((?:found|set with --credentials|set with --knowledge|chosen by you|kept from the last run)\)$'
    $sameProfile = (($finalProfile -replace "`r`n","`n" -replace '(?m), set with --repos(?=\)$)','' -replace $normPattern,'DATE') -ceq
        ($currentProfile -replace "`r`n","`n" -replace '(?m), set with --repos(?=\)$)','' -replace $normPattern,'DATE'))
    $profilePlan = $planItems | Where-Object { $_.TgtPath -eq $ProfileMd } | Select-Object -First 1
    if ($sameProfile) {
        $profilePlan.Action = 'UNCHANGED'
    } else {
        if (Test-Path -LiteralPath $ProfileMd -PathType Leaf) {
            if ($toBackup -notcontains $ProfileMd) {
                if (-not (Backup-File -FilePath $ProfileMd -HomeRoot $HomeDir -BackupDir $backupDir)) { throw 'Could not back up the team profile' }
                $anyBackup = $true
            }
            $profilePlan.Action = 'UPDATE'
        } else { $profilePlan.Action = 'CREATE' }
        Ensure-Dir (Split-Path -Parent $ProfileMd)
        Write-Utf8NoBom -Path $ProfileMd -Text $finalProfile
    }
    $finalBytes = if ($sameProfile) { [IO.File]::ReadAllBytes($ProfileMd) } else { $EncUtf8NoBom.GetBytes($finalProfile) }
    $desired[$ProfileMd] = @{ Bytes = $finalBytes; Hash = (Get-Sha256Bytes $finalBytes); Kind = 'rendered' }
}
foreach ($kv in $desired.GetEnumerator()) {
    $tp    = $kv.Key
    $entry = $kv.Value
    $pi    = $planItems | Where-Object { $_.TgtPath -eq $tp } | Select-Object -First 1
    if ($null -eq $pi -or $pi.Action -eq 'UNCHANGED') { continue }
    $actual = Get-Sha256OrAbsent -Path $tp
    if ($actual -ne $entry.Hash) {
        Write-Output "ERROR: post-write hash mismatch for $tp (backups at $backupDir)"
        exit 1
    }
}

# ─── Write receipt (schema 2) ─────────────────────────────────────────────────

$receiptFiles = [ordered]@{}
foreach ($kv in $desired.GetEnumerator()) {
    $tp   = $kv.Key
    $pi   = $planItems | Where-Object { $_.TgtPath -eq $tp } | Select-Object -First 1
    if ($null -ne $pi -and $pi.Action -ne 'SKIP') {
        $receiptFiles[$tp] = $kv.Value.Hash
    }
}
# Kept files (degraded, from previous receipt)
foreach ($kv in $keptFiles.GetEnumerator()) { $receiptFiles[$kv.Key] = $kv.Value }
# Files kept because someone changed them stay listed with their previous hash, so they stay ours.
foreach ($fp in $pruneKeep) { $receiptFiles[$fp] = $prevReceipt.files.PSObject.Properties[$fp].Value }
# CLAUDE.md
if ($hasClaude) { $receiptFiles[$ClaudeMd] = Get-Sha256 -Path $ClaudeMd }
if ($null -ne $CodexRecord) {
    if ($CodexAction -in @('CREATE','UPDATE','UNCHANGED') -and (Get-CodexSkipReason) -eq '' -and $CodexRecord.path -ieq $CodexCanonical -and (Test-Path -LiteralPath $CodexAgentsFile -PathType Leaf)) {
        $receiptFiles[$CodexAgentsFile] = Get-Sha256 $CodexAgentsFile
    } elseif ($null -ne $prevReceipt -and $prevReceipt.files.PSObject.Properties[$CodexAgentsFile]) { $receiptFiles[$CodexAgentsFile] = $prevReceipt.files.PSObject.Properties[$CodexAgentsFile].Value }
}

# refresh record
$refreshAt = [System.DateTime]::UtcNow.ToString('o')
if ($checkSuccess) {
    $refreshObj = [ordered]@{ status = 'ok'; at = $refreshAt }
} elseif (-not $nodeVersionOk) {
    $refreshObj = [ordered]@{ status = 'skipped'; reason = 'no Node 18+'; at = $refreshAt }
} else {
    $refreshObj = [ordered]@{ status = 'failed'; reason = $checkFailReason; at = $refreshAt }
}

# consensus and lanes for receipt; the repos folder (from the check, else kept or as given)
$receiptConsensus = $null
$receiptLanes     = $null
$receiptRepos     = $null
if (-not [string]::IsNullOrWhiteSpace($reposArg)) { $receiptRepos = [ordered]@{ path = $reposArg; count = $null } }

if ($checkSuccess -and -not [string]::IsNullOrWhiteSpace($checkReceiptJson)) {
    try {
        $crj = $checkReceiptJson | ConvertFrom-Json
        if ($crj.PSObject.Properties['consensus']) { $receiptConsensus = $crj.consensus }
        if ($crj.PSObject.Properties['lanes'])     { $receiptLanes     = $crj.lanes     }
        if ($crj.PSObject.Properties['repos'])     { $receiptRepos     = $crj.repos     }
    } catch {}
} elseif ($isDegraded -and $hasPrevInstall) {
    if ($prevReceipt.PSObject.Properties['schema'] -and $prevReceipt.schema -eq 2) {
        $receiptConsensus = if ($prevReceipt.PSObject.Properties['consensus']) { $prevReceipt.consensus } else { $null }
        $receiptLanes     = if ($prevReceipt.PSObject.Properties['lanes'])     { $prevReceipt.lanes     } else { $null }
    }
    # schema 1: leave null
} else {
    # fresh degraded
    $receiptConsensus = [ordered]@{ grade = 'off'; pair = @(); reason = $consensusText }
    $receiptLanes     = [ordered]@{}
}

$receiptRelays = @($RelayNames)

$ladderRecord = [ordered]@{ owned = $ladderOwned; lastInstalled = $ladderLastInstalled;
    lastAttempt = [ordered]@{ status = $ladderStatus; reason = $ladderReason; at = [DateTime]::UtcNow.ToString('o') } }
$receiptObj = [ordered]@{
    schema                = 2
    packetVersion         = $PacketVersion
    previousPacketVersion = if ($null -ne $prevPacketVersion) { $prevPacketVersion } else { $null }
    installedAt           = [System.DateTime]::UtcNow.ToString('o')
    platform              = 'windows'
    home                  = $CanonicalHome
    hostMode              = $hostMode
    tools                 = [ordered]@{
        claude = if ($hasClaude) { $claudeVersion } else { 'not found' }
        node   = if ($null -eq $nodeVersion)  { 'not installed' } else { $nodeVersion  }
        codex  = if ($null -eq $codexVersion) { 'not installed' } else { $codexVersion }
        cursor = if ($null -eq $cursorVersion){ 'not installed' } else { $cursorVersion }
        muse   = if ($null -eq $museVersion)  { 'not installed' } else { $museVersion  }
    }
    unavailable           = $unavailableList
    refresh               = $refreshObj
    ladder                = $null # Serialized on one line below, for Node-less bash recovery.
    codexSection          = $null # Also one line: ownership, canonical path and exact separator.
    consensus             = $receiptConsensus
    lanes                 = $receiptLanes
    repos                 = $receiptRepos
    folders               = $null # Compact for Node-less sh recovery.
    relays                = $receiptRelays
    files                 = $receiptFiles
    backupDir             = if ($anyBackup) { $backupDir } elseif ($null -ne $prevReceipt -and $prevReceipt.PSObject.Properties['backupDir']) { $prevReceipt.backupDir } else { '' }
}

Ensure-Dir -Path (Split-Path -Parent $ReceiptFile)
$receiptJson = $receiptObj | ConvertTo-Json -Depth 10
$foldersJson = $receiptFolders | ConvertTo-Json -Depth 10 -Compress
# Keep legal Windows path characters literal for the Node-free sh receipt reader.
# Match only JSON unicode escapes, not a literal backslash followed by u0027/u0026.
$foldersJson = [regex]::Replace($foldersJson, '(^|[^\\])((?:\\\\)*)\\u(0027|0026)', {
    param($m)
    $character = if ($m.Groups[3].Value -eq '0027') { "'" } else { '&' }
    $m.Groups[1].Value + $m.Groups[2].Value + $character
})
$receiptJson = [regex]::Replace($receiptJson, '(?m)^(\s*)"folders":\s*null,', { param($m) $m.Groups[1].Value + '"folders": ' + $foldersJson + ',' })
$codexJson = if ($null -ne $CodexRecord) { $CodexRecord | ConvertTo-Json -Depth 10 -Compress } else { 'null' }
$receiptJson = [regex]::Replace($receiptJson, '(?m)^(\s*)"codexSection":\s*null,', { param($m) $m.Groups[1].Value + '"codexSection": ' + $codexJson + ',' })
$ladderJson = $ladderRecord | ConvertTo-Json -Depth 10 -Compress
$receiptJson = [regex]::Replace($receiptJson, '(?m)^(\s*)"ladder":\s*null,', {
    param($m) $m.Groups[1].Value + '"ladder": ' + $ladderJson + ','
})
Write-Utf8NoBom -Path $ReceiptFile -Text $receiptJson

# ─── Step 13: Post-install doctor ────────────────────────────────────────────

if ($hasRuntime -and (Test-Path -LiteralPath $RefereePath -PathType Leaf)) {
    Write-Output ''
    Write-Output '--- Referee doctor ---'
    $tmpDoc = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.txt')
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName  = 'cmd.exe'
        $psi.Arguments = '/d /s /c "node "' + $RefereePath + '" doctor --human > "' + $tmpDoc + '" 2>&1"'
        $psi.CreateNoWindow  = $true
        $psi.UseShellExecute = $false
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.WaitForExit() | Out-Null
        if (Test-Path -LiteralPath $tmpDoc) { Get-Content -LiteralPath $tmpDoc | ForEach-Object { Write-Output $_ } }
    } finally {
        Remove-Item -LiteralPath $tmpDoc -Force -ErrorAction SilentlyContinue
    }
}

# ─── Step 14: Summary ────────────────────────────────────────────────────────

$created   = @($planItems | Where-Object { $_.Action -eq 'CREATE'    }).Count
$updated   = @($planItems | Where-Object { $_.Action -eq 'UPDATE'    }).Count
$unchanged = @($planItems | Where-Object { $_.Action -eq 'UNCHANGED' }).Count
$removed   = @($planItems | Where-Object { $_.Action -eq 'REMOVE'    }).Count
$kept      = @($planItems | Where-Object { $_.Action -eq 'KEEP'      }).Count
$skipped   = @($planItems | Where-Object { $_.Action -eq 'SKIP'      }).Count

Write-Output ''
Write-Output '--- Summary ---'
Write-Output "Mode: $hostMode"
Write-Output (Get-LadderSummary)
Write-Output $entryText
if ($CodexReason -like 'CODEX_HOME points to*') { Write-Output ('Add the "## Delegation (shared rulebook)" section to "{0}/AGENTS.md" yourself, pointing at {1}/POLICY.md and profiles/team.md.' -f $env:CODEX_HOME, $PolicyDir) }

# Model check result (first line)
if ($checkSuccess) {
    Write-Output 'Model check: done'
} elseif (-not $nodeVersionOk) {
    Write-Output 'Model check: skipped (no Node 18+)'
} elseif ($hasPrevInstall) {
    Write-Output "Model check: failed ($checkFailReason); your previous reviewer and lane setup is kept unchanged"
} else {
    Write-Output "Model check: failed ($checkFailReason); reviews are off until it succeeds"
}

# Muse contributor protection, from the relay file actually installed here (this packet's, one kept from before, or
# the person's own). Only this packet's own relay (same SHA-256) is known to pass --contributor-mode off on every run;
# another relay that merely mentions the flag cannot be confirmed.
$MuseRelayFile   = Join-Path $HomeDir '.claude\skills\muse-delegate\scripts\relay.mjs'
$PacketMuseRelay = Join-Path $PacketRoot 'skills\muse-delegate\scripts\relay.mjs'
if (Test-Path -LiteralPath $MuseRelayFile -PathType Leaf) {
    $museRelayText = ''
    try { $museRelayText = [System.IO.File]::ReadAllText($MuseRelayFile) } catch { $museRelayText = '' }
    $museRelayIsPackets = $false
    if (Test-Path -LiteralPath $PacketMuseRelay -PathType Leaf) {
        try {
            $museRelayIsPackets = (Get-FileHash -LiteralPath $MuseRelayFile -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $PacketMuseRelay -Algorithm SHA256).Hash
        } catch { $museRelayIsPackets = $false }
    }
    if ($museRelayIsPackets) {
        if ($MuseContributorOn) {
            Write-Output "WARNING: Muse contributor mode is ON in ${MuseSettingsFile}. The Muse relay at $MuseRelayFile switches it off for every job it runs; what you run in Muse yourself is not covered, so switch it off in Muse too."
        }
    } elseif ($museRelayText.Contains('"--contributor-mode", "off"')) {
        Write-Output "WARNING: the Muse relay at $MuseRelayFile is not this packet's relay (it was kept from before or installed by you). It mentions --contributor-mode off, but the installer cannot confirm that it switches off Meta's contributor tier for its jobs. If you installed it yourself, move it away and run this installer again to get the packet's relay."
    } else {
        Write-Output "WARNING: the Muse relay at $MuseRelayFile does not switch off Meta's contributor tier (it was kept from before or installed by you), so its jobs follow this machine's Muse setting. If you installed it yourself, move it away and run this installer again to get the packet's relay."
    }
} elseif ($MuseContributorOn) {
    Write-Output "WARNING: Muse contributor mode is ON in ${MuseSettingsFile} and no Muse relay is installed here to switch it off: switch it off in Muse."
}
# The Muse relay refuses a Muse older than 1.4.15, the first version known to accept --contributor-mode off.
if ($null -ne $museVersion) {
    $museXyz = Get-VersionXYZ $museVersion
    if ($museXyz -and ([version]$museXyz -lt [version]'1.4.15')) {
        Write-Output "WARNING: Muse $museXyz is older than 1.4.15: the Muse relay refuses it (it needs --contributor-mode off), so every Muse relay job fails until Muse is updated."
    }
}

Write-Output "  Created:   $created  Updated: $updated  Unchanged: $unchanged  Removed: $removed  Kept: $kept  Skipped: $skipped"
if (-not $hasClaude) {
    Write-Output '  Claude Code helpers and CLAUDE.md: skipped or kept (Claude Code not found)'
} elseif ($sonnetSrcDir -eq 'claude\agents\sonnet-4-6') {
    Write-Output "  Sonnet helper definitions: $AgentsDir (Claude Sonnet 4.6: Claude Code older than 2.1.284)"
} else {
    Write-Output "  Sonnet helper definitions: $AgentsDir (Claude Sonnet 5.5)"
}

# Lane choices
if ($checkSuccess) {
    foreach ($sl in $checkSummaryLines) { Write-Output "  $sl"; if ($sl -like 'Repositories:*') { $foldersSummary | ForEach-Object { Write-Output "  $_" } } }
}

# Declared-unavailable
if ($unavailableList.Count -gt 0) {
    Write-Output "  Unavailable models declared: $($unavailableList -join ', ')"
    Write-Output "  To change: run installer with --unavailable <ids> (add) or --clear-unavailable (reset)"
} else {
    Write-Output '  No models declared unavailable.'
    Write-Output '  To exclude a model: run installer with --unavailable <id1,id2>'
}

if ($anyBackup) { Write-Output "  Backups: $backupDir" }
Write-Output '  To undo: run this installer again with --uninstall'
Write-Output '  After you update Claude Code, Codex or Cursor, or log in to one of them, run this installer again: it re-checks your models.'
Write-Output ''
Write-Output 'Next step: start a new session in your agent.'

# Cleanup temp files
Remove-Item -LiteralPath $settingsTempPath -Force -ErrorAction SilentlyContinue
if ($null -ne $checkOutDir -and (Test-Path -LiteralPath $checkOutDir)) {
    Remove-Item -LiteralPath $checkOutDir -Recurse -Force -ErrorAction SilentlyContinue
}
