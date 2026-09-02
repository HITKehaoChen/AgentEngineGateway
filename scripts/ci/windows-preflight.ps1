[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Condition {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

Write-Host "Running Windows preflight in: $RepositoryRoot"
Assert-Condition -Condition $IsWindows -Message "This preflight must run on Windows."
Assert-Condition -Condition ($env:RUNNER_OS -eq "Windows") -Message "Expected GitHub runner OS to be Windows."

$requiredFiles = @(
    "docs/Agent网关接口规范.md",
    "docs/多Agent引擎可替换架构实现-任务书.md",
    "docs/多Agent引擎可替换架构实现-调测指南.md"
)

foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $RepositoryRoot $relativePath
    Assert-Condition -Condition (Test-Path -LiteralPath $fullPath -PathType Leaf) -Message "Required file is missing: $relativePath"
    Write-Host "Found required file: $relativePath"
}

Push-Location $RepositoryRoot
try {
    $trackedFiles = @(git ls-files)
    Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message "Unable to enumerate tracked files with git ls-files."
} finally {
    Pop-Location
}

$caseInsensitiveGroups = @(
    $trackedFiles | Group-Object { $_.ToLowerInvariant() } | Where-Object Count -GT 1
)
Assert-Condition -Condition ($caseInsensitiveGroups.Count -eq 0) -Message (
    "Tracked paths collide on a case-insensitive Windows file system: " +
    ((@($caseInsensitiveGroups | ForEach-Object { $_.Group }) -join ", "))
)

$reservedNames = @(
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
)

foreach ($path in $trackedFiles) {
    foreach ($segment in ($path -split "/")) {
        $baseName = ($segment -split "\.")[0].ToUpperInvariant()
        Assert-Condition -Condition ($baseName -notin $reservedNames) -Message "Windows-reserved path segment found: $path"
        Assert-Condition -Condition (-not $segment.EndsWith(".")) -Message "Windows-incompatible trailing dot found: $path"
        Assert-Condition -Condition (-not $segment.EndsWith(" ")) -Message "Windows-incompatible trailing space found: $path"
    }
}

$summary = @"
## Windows preflight passed

- Runner: $env:RUNNER_OS
- Windows: $([System.Environment]::OSVersion.VersionString)
- PowerShell: $($PSVersionTable.PSVersion)
- Tracked files checked: $($trackedFiles.Count)
- Required competition documents: $($requiredFiles.Count)
"@

if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $summary -Encoding utf8
}

Write-Host "Windows preflight passed. Checked $($trackedFiles.Count) tracked files."
