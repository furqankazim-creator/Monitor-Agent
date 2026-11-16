<#
.SYNOPSIS
    Time Global Tech Monitor - Windows Server Agent (PowerShell)
    Pushes server metrics (CPU, RAM, Disks, Services, Top Processes) over HTTPS.
.EXAMPLE
    $env:TGT_URL="https://monitor.example.com"
    $env:TGT_TOKEN="tgtm_xxxxxxxxxxxx"
    powershell -ExecutionPolicy Bypass -File .\agent.ps1
#>
[CmdletBinding()]
param(
    [string]$Url = $env:TGT_URL,
    [string]$Token = $env:TGT_TOKEN,
    [int]$Interval = $(if ($env:TGT_INTERVAL) { [int]$env:TGT_INTERVAL } else { 60 }),
    [string]$Services = $env:TGT_SERVICES,
    [switch]$Test
)

$ErrorActionPreference = 'SilentlyContinue'
$Url = $Url.TrimEnd('/')

if (-not $Url -or -not $Token) {
    Write-Error "TGT_URL and TGT_TOKEN are required. Pass them as parameters or environment variables."
    exit 1
}

$Version = "2.0.0-win"
$ServiceList = if ($Services) { $Services.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @() }

function Get-AgentMetrics {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalRamMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 1)
    $freeRamMb = [math]::Round($os.FreePhysicalMemory / 1024, 1)
    $ramPercent = [math]::Round((($totalRamMb - $freeRamMb) / $totalRamMb) * 100, 1)

    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $uptimeSec = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds

    # Disks
    $disks = @()
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
        $totalGb = [math]::Round($_.Size / 1GB, 1)
        $freeGb = [math]::Round($_.FreeSpace / 1GB, 1)
        $usedGb = [math]::Round($totalGb - $freeGb, 1)
        $pct = if ($totalGb -gt 0) { [math]::Round(($usedGb / $totalGb) * 100, 1) } else { 0 }
        $disks += @{
            mount = $_.DeviceID
            percent = $pct
            total_gb = $totalGb
            used_gb = $usedGb
        }
    }

    # Top 5 Processes by CPU
    $topProc = @()
    Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object {
        $topProc += @{
            pid = $_.Id
            cpu = [math]::Round($_.CPU, 1)
            ram = [math]::Round($_.WorkingSet / 1MB, 1)
            user = $_.UserName
            command = $_.ProcessName
        }
    }

    # Registered Services
    $srvStatus = @()
    foreach ($sName in $ServiceList) {
        $s = Get-Service -Name $sName -ErrorAction SilentlyContinue
        $srvStatus += @{
            name = $sName
            running = ($s -and $s.Status -eq 'Running')
        }
    }

    return @{
        agent_version = $Version
        hostname = $env:COMPUTERNAME
        os = "Windows ($($os.Caption))"
        cores = [System.Environment]::ProcessorCount
        cpu_percent = $cpu
        ram_percent = $ramPercent
        ram_available_mb = $freeRamMb
        load1 = [math]::Round($cpu / 100 * [System.Environment]::ProcessorCount, 2)
        uptime_s = $uptimeSec
        disks = $disks
        services = $srvStatus
        top_processes = $topProc
    }
}

function Send-Report {
    param($payload)
    $json = $payload | ConvertTo-Json -Depth 5
    $headers = @{
        "Authorization" = "Bearer $Token"
        "Content-Type" = "application/json"
    }
    $res = Invoke-RestMethod -Uri "$Url/api/agent/ingest" -Method Post -Headers $headers -Body $json -TimeoutSec 15
    if ($res.interval_sec) {
        $script:Interval = [math]::Max(10, $res.interval_sec)
    }
    if ($res.services -is [System.Array]) {
        $script:ServiceList = $res.services
    }
    return $res
}

if ($Test) {
    Write-Host "`nTesting Windows Server Agent..." -ForegroundColor Cyan
    $payload = Get-AgentMetrics
    Write-Host ($payload | ConvertTo-Json -Depth 5)
    try {
        $null = Send-Report -payload $payload
        Write-Host "`nSuccess: Report ingested by $Url" -ForegroundColor Green
        exit 0
    } catch {
        Write-Error "Ingest failed: $_"
        exit 1
    }
}

Write-Host "TGT Monitor Agent (Windows) started. Reporting to $Url every $Interval seconds..."
while ($true) {
    try {
        $p = Get-AgentMetrics
        $null = Send-Report -payload $p
        Write-Host "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') Reported (CPU: $($p.cpu_percent)%, RAM: $($p.ram_percent)%)"
    } catch {
        Write-Warning "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') Report failed: $_"
    }
    Start-Sleep -Seconds $Interval
}
