[CmdletBinding()]
param(
    [string]$GatewayUrl = "http://127.0.0.1:6217",
    [Parameter(Mandatory)] [string]$Directory,
    [Parameter(Mandatory)] [string]$SourceDocument,
    [string]$TargetDocument,
    [ValidateSet("opencode", "pi")] [string]$Engine = "opencode",
    [string]$ModelProvider = $(if ($env:MODEL_PROVIDER_ID) { $env:MODEL_PROVIDER_ID } else { "glm" }),
    [string]$ModelId = $(if ($env:MODEL_ID) { $env:MODEL_ID } else { "glm-5.2" }),
    [string]$QuestionAnswer = "继续",
    [ValidateSet("once", "always", "reject")] [string]$PermissionReply = "always"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SourceDocument -PathType Leaf)) { throw "Source document does not exist: $SourceDocument" }
if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw "Directory does not exist: $Directory" }
$SourceDocument = (Resolve-Path -LiteralPath $SourceDocument).Path
$Directory = (Resolve-Path -LiteralPath $Directory).Path
if (-not $TargetDocument) {
    $sourceName = [System.IO.Path]::GetFileNameWithoutExtension($SourceDocument)
    $TargetDocument = Join-Path $Directory ($sourceName + "_执行摘要润色版.docx")
}
$TargetDocument = [System.IO.Path]::GetFullPath($TargetDocument)
if (Test-Path -LiteralPath $TargetDocument) { throw "Target document already exists; use a clean per-engine directory: $TargetDocument" }
$sourceHash = (Get-FileHash -LiteralPath $SourceDocument -Algorithm SHA256).Hash

$prompt = '请打开 {0}，把“执行摘要”中介绍 OpenClaw 影响力和行业采用情况的两段文字改写成更克制、正式、适合内部研究汇报的表述。不要改动事实信息和章节结构，保留 GitHub Stars、MIT、自托管、主流云厂商采用等关键信息，并另存为同目录下的 {1}。' -f $SourceDocument, $TargetDocument
$headers = @{ "Content-Type" = "application/json" }
$session = $null
$job = $null
$sseJob = $null

function Get-Json($Path) { Invoke-RestMethod -Method Get -Uri ($GatewayUrl.TrimEnd("/") + $Path) -Headers $headers }
function Send-Json($Method, $Path, $Body) { Invoke-RestMethod -Method $Method -Uri ($GatewayUrl.TrimEnd("/") + $Path) -Headers $headers -Body ($Body | ConvertTo-Json -Depth 12) }
function Get-SseOutput { if ($sseJob) { return ((Receive-Job $sseJob -Keep -ErrorAction SilentlyContinue) | Out-String) }; return "" }
function Assert-ValidDocx($Path) {
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -eq 0) { throw "Target document is empty: $Path" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = $null
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($file.FullName)
        $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
        if ($names -notcontains "[Content_Types].xml" -or $names -notcontains "word/document.xml") {
            throw "Target is not a valid Word docx package: $Path"
        }
    } catch {
        throw "Target document cannot be opened as docx: $($_.Exception.Message)"
    } finally {
        if ($archive) { $archive.Dispose() }
    }
}

try {
    $sseJob = Start-Job -ScriptBlock {
        param($EventUri)
        Add-Type -AssemblyName System.Net.Http
        $client = [System.Net.Http.HttpClient]::new()
        $response = $null
        $stream = $null
        $reader = $null
        try {
            $client.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream")
            $response = $client.GetAsync($EventUri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            $response.EnsureSuccessStatusCode()
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $reader = [System.IO.StreamReader]::new($stream)
            while (-not $reader.EndOfStream) { Write-Output $reader.ReadLine() }
        } finally {
            if ($reader) { $reader.Dispose() }
            elseif ($stream) { $stream.Dispose() }
            if ($response) { $response.Dispose() }
            $client.Dispose()
        }
    } -ArgumentList ("$($GatewayUrl.TrimEnd('/'))/event")
    $sseDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-SseOutput) -notmatch '"type":"server.connected"') {
        if ($sseJob.State -notin @("NotStarted", "Running")) { throw "SSE connection ended before server.connected: $(Get-SseOutput)" }
        if ([DateTime]::UtcNow -ge $sseDeadline) { throw "Timed out waiting for SSE server.connected" }
        Start-Sleep -Milliseconds 100
    }

    $directoryQuery = [uri]::EscapeDataString($Directory)
    $session = Send-Json "Post" "/session?directory=$directoryQuery" @{ title = "office_011 - $Engine" }
    $model = @{ providerID = $ModelProvider; modelID = $ModelId }
    $body = @{ parts = @(@{ type = "text"; text = $prompt }); model = $model }
    $job = Start-Job -ScriptBlock {
        param($PromptUri, $Json)
        Invoke-WebRequest -Method Post -Uri $PromptUri -ContentType "application/json" -Body $Json -TimeoutSec 7200
    } -ArgumentList (("$($GatewayUrl.TrimEnd('/'))/session/$($session.id)/prompt_async"), ($body | ConvertTo-Json -Depth 12))

    while ($job.State -in @("NotStarted", "Running")) {
        foreach ($question in @(Get-Json "/question" | Where-Object { $_.sessionID -eq $session.id })) {
            Send-Json "Post" "/question/$($question.id)/reply" @{ answers = @(@($QuestionAnswer)) } | Out-Null
        }
        foreach ($permission in @(Get-Json "/permission" | Where-Object { $_.sessionID -eq $session.id })) {
            Send-Json "Post" "/permission/$($permission.id)/reply" @{ reply = $PermissionReply } | Out-Null
        }
        Start-Sleep -Milliseconds 500
    }
    if ($job.State -ne "Completed") { throw ((Receive-Job $job -ErrorAction SilentlyContinue) | Out-String) }
    $promptResponse = Receive-Job $job
    if ($promptResponse.StatusCode -ne 204) { throw "prompt_async returned HTTP $($promptResponse.StatusCode)" }

    $status = (Get-Json "/session/status").$($session.id)
    if ($status.type -ne "idle") { throw "Session did not return to idle: $($status.type)" }
    $messages = @(Get-Json "/session/$($session.id)/message")
    if (-not ($messages | Where-Object { $_.role -eq "assistant" })) { throw "No final assistant message was projected" }
    if (-not ($messages | Where-Object { $_.role -eq "tool" })) { throw "No completed tool result was projected" }
    if (-not (Test-Path -LiteralPath $TargetDocument -PathType Leaf)) { throw "Target document was not created: $TargetDocument" }
    Assert-ValidDocx $TargetDocument
    $afterHash = (Get-FileHash -LiteralPath $SourceDocument -Algorithm SHA256).Hash
    if ($afterHash -ne $sourceHash) { throw "Source document was modified" }
    $sseText = Get-SseOutput
    foreach ($eventType in @("server.connected", "session.status", "message.part.updated", "session.idle")) {
        if ($sseText -notmatch ('"type":"' + [regex]::Escape($eventType) + '"')) { throw "SSE event was not observed: $eventType" }
    }
    if ($sseText -notmatch [regex]::Escape($session.id)) { throw "SSE stream did not contain the current session id" }
    Write-Host "office_011 gateway E2E passed ($Engine): $TargetDocument"
} finally {
    if ($job) { Remove-Job $job -Force -ErrorAction SilentlyContinue }
    if ($sseJob) { Stop-Job $sseJob -ErrorAction SilentlyContinue; Remove-Job $sseJob -Force -ErrorAction SilentlyContinue }
    if ($session) {
        try { Send-Json "Delete" "/session/$($session.id)" @{} | Out-Null }
        catch { Write-Warning "Session cleanup failed: $($_.Exception.Message)" }
    }
}
