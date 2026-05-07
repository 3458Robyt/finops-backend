<#
.SYNOPSIS
Validates and optionally configures OCI access for FOCUS Cost Reports.

.DESCRIPTION
This script is intentionally conservative. By default it only validates the
local OCI CLI profile and lists recent FOCUS Cost Reports from the Oracle
managed reporting bucket. It creates an IAM policy only when -CreatePolicy is
explicitly provided.

It does not store credentials, download reports, write to the FinOps database,
or ingest cost data.
#>

[CmdletBinding()]
param(
  [string]$Profile = "DEFAULT",
  [ValidateSet("api_key", "security_token", "instance_principal", "resource_principal")]
  [string]$Auth = "api_key",
  [string]$ConfigPath = (Join-Path $HOME ".oci\config"),
  [string]$TenancyId,
  [string]$Region,
  [string]$GroupName,
  [string]$PolicyName = "FinOpsFocusReportReadPolicy",
  [switch]$BrowserLogin,
  [switch]$CreatePolicy,
  [switch]$SkipListReports,
  [string]$Prefix = "FOCUS Reports",
  [ValidateRange(1, 1000)]
  [int]$Limit = 10,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$OracleUsageReportTenancyOcid = "ocid1.tenancy.oc1..aaaaaaaaned4fkpkisbwjlr56u7cj63lf3wffbilvqknstgtvzub7vhqkggq"
$ReportingNamespace = "bling"

function Show-Help {
  @"
OCI FOCUS bootstrap

Common flows:

  1) Validate an existing OCI CLI API-key profile and list FOCUS reports:
     .\scripts\oci-focus-bootstrap.ps1 -Profile DEFAULT

  2) Authenticate with browser, then validate/list FOCUS reports:
     .\scripts\oci-focus-bootstrap.ps1 -BrowserLogin -Region <home-region>

  3) Create the minimum IAM policy, then list FOCUS reports:
     .\scripts\oci-focus-bootstrap.ps1 -Profile DEFAULT -GroupName FinOpsCostReportsReaders -CreatePolicy

  4) Only print/validate setup without listing reports:
     .\scripts\oci-focus-bootstrap.ps1 -Profile DEFAULT -SkipListReports

Required OCI policy statements:

  define tenancy usage-report as $OracleUsageReportTenancyOcid
  endorse group <group_name> to read objects in tenancy usage-report

Notes:

  - The script reads tenancy and region from the OCI CLI config profile unless
    -TenancyId or -Region is provided.
  - -BrowserLogin launches the official 'oci session authenticate' browser flow
    and then uses -Auth security_token.
  - The script does not store or print secrets.
"@ | Write-Host
}

function Assert-OciCli {
  $ociCommand = Get-Command oci -ErrorAction SilentlyContinue
  if ($null -ne $ociCommand) {
    return
  }

  $userBinOci = Join-Path $HOME "bin\oci.exe"
  if (Test-Path -LiteralPath $userBinOci) {
    $userBin = Split-Path -Parent $userBinOci
    $env:Path = "$userBin;$env:Path"
    return
  }

  throw "OCI CLI was not found. Install it or create a CLI session before running this script. See: https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm"
}

function Invoke-BrowserLogin {
  if ([string]::IsNullOrWhiteSpace($Region)) {
    $Region = Read-OciProfileValue -Path $ConfigPath -ProfileName $Profile -Key "region"
  }

  if ([string]::IsNullOrWhiteSpace($Region)) {
    $Region = Read-Host "Home region OCI, for example sa-bogota-1 or us-ashburn-1"
  }

  if ([string]::IsNullOrWhiteSpace($Region)) {
    throw "-Region is required when -BrowserLogin is used."
  }

  Write-Host ""
  Write-Host "Opening official OCI CLI browser authentication..."
  Write-Host "Complete login/MFA in the browser. This script does not read or store your credentials."
  Write-Host ""

  & oci session authenticate --region $Region --profile-name $Profile
  if ($LASTEXITCODE -ne 0) {
    throw "OCI browser authentication failed."
  }

  Write-Host "[OK] Browser authentication completed for profile '$Profile'."
}

function Read-OciProfileValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ProfileName,
    [Parameter(Mandatory = $true)][string]$Key
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $insideProfile = $false
  $escapedKey = [regex]::Escape($Key)

  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()

    if ($line -match "^\[(.+)\]$") {
      $insideProfile = ($Matches[1] -eq $ProfileName)
      continue
    }

    if ($insideProfile -and $line -match "^$escapedKey\s*=\s*(.+)$") {
      return $Matches[1].Trim()
    }
  }

  return $null
}

function Get-OciBaseArgs {
  $baseArgs = @()

  if (-not [string]::IsNullOrWhiteSpace($Profile)) {
    $baseArgs += @("--profile", $Profile)
  }

  if ($Auth -ne "api_key") {
    $baseArgs += @("--auth", $Auth)
  }

  $baseArgs += @("--output", "json")
  return $baseArgs
}

function Invoke-OciJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $finalArgs = @($Arguments + (Get-OciBaseArgs))
  Write-Verbose ("oci " + ($finalArgs -join " "))

  $output = & oci @finalArgs 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | Out-String).Trim()

  if ($exitCode -ne 0) {
    throw "OCI CLI command failed: oci $($finalArgs -join ' ')`n$text"
  }

  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }

  try {
    return $text | ConvertFrom-Json -Depth 80
  } catch {
    throw "OCI CLI did not return valid JSON for: oci $($finalArgs -join ' ')`n$text"
  }
}

function Get-ObjectProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string[]]$Names
  )

  foreach ($name in $Names) {
    $property = $Object.PSObject.Properties[$name]
    if ($null -ne $property) {
      return $property.Value
    }
  }

  return $null
}

function Show-RequiredPolicy {
  Write-Host ""
  Write-Host "Required OCI policy:"
  Write-Host "  define tenancy usage-report as $OracleUsageReportTenancyOcid"
  Write-Host "  endorse group <group_name> to read objects in tenancy usage-report"
}

function Ensure-UsageReportPolicy {
  if (-not $CreatePolicy) {
    Show-RequiredPolicy
    Write-Host ""
    Write-Host "No IAM changes were made. Pass -CreatePolicy -GroupName <group_name> to create the policy."
    return
  }

  if ([string]::IsNullOrWhiteSpace($GroupName)) {
    throw "-GroupName is required when -CreatePolicy is used."
  }

  $statements = @(
    "define tenancy usage-report as $OracleUsageReportTenancyOcid",
    "endorse group $GroupName to read objects in tenancy usage-report"
  )

  Write-Host ""
  Write-Host "Checking IAM policy '$PolicyName' in root compartment..."

  $policyList = Invoke-OciJson @("iam", "policy", "list", "--compartment-id", $TenancyId, "--all")
  $policies = @($policyList.data)
  $existing = $policies | Where-Object { $_.name -eq $PolicyName } | Select-Object -First 1

  if ($null -ne $existing) {
    Write-Host "[OK] Policy already exists: $PolicyName"
    return
  }

  $statementsJson = $statements | ConvertTo-Json -Compress

  Write-Host "Creating IAM policy '$PolicyName' for group '$GroupName'..."
  $created = Invoke-OciJson @(
    "iam", "policy", "create",
    "--compartment-id", $TenancyId,
    "--name", $PolicyName,
    "--description", "Allows FinOps ingestion to read OCI FOCUS Cost Reports.",
    "--statements", $statementsJson
  )

  $createdId = Get-ObjectProperty -Object $created.data -Names @("id")
  Write-Host "[OK] Policy created: $PolicyName"
  if (-not [string]::IsNullOrWhiteSpace($createdId)) {
    Write-Host "     OCID: $createdId"
  }
}

function Get-ReportObjects {
  $response = Invoke-OciJson @(
    "os", "object", "list",
    "--namespace-name", $ReportingNamespace,
    "--bucket-name", $TenancyId,
    "--prefix", $Prefix,
    "--limit", [string]$Limit
  )

  if ($null -eq $response) {
    return @()
  }

  $data = $response.data

  if ($null -ne $data -and $null -ne $data.objects) {
    return @($data.objects)
  }

  if ($data -is [array]) {
    return @($data)
  }

  return @()
}

function List-FocusReports {
  if ($SkipListReports) {
    return
  }

  Write-Host ""
  Write-Host "Listing OCI FOCUS Cost Reports..."
  Write-Host "  Namespace: $ReportingNamespace"
  Write-Host "  Bucket:    $TenancyId"
  Write-Host "  Prefix:    $Prefix"

  $objects = Get-ReportObjects

  if ($objects.Count -eq 0) {
    Write-Warning "No FOCUS reports were returned. Check home region, tenancy billing status, and the required IAM policy."
    return
  }

  $rows = foreach ($object in $objects) {
    $name = Get-ObjectProperty -Object $object -Names @("name")
    $size = Get-ObjectProperty -Object $object -Names @("size")
    $timeCreated = Get-ObjectProperty -Object $object -Names @("time-created", "timeCreated")

    [PSCustomObject]@{
      Name = $name
      SizeBytes = $size
      TimeCreated = $timeCreated
    }
  }

  $rows |
    Sort-Object TimeCreated -Descending |
    Select-Object -First $Limit |
    Format-Table -AutoSize

  Write-Host "[OK] OCI FOCUS report access is working."
}

if ($Help) {
  Show-Help
  exit 0
}

if ($BrowserLogin -and -not $PSBoundParameters.ContainsKey("Profile")) {
  $Profile = "finops-oci"
}

if ($BrowserLogin -and -not $PSBoundParameters.ContainsKey("Auth")) {
  $Auth = "security_token"
}

Assert-OciCli

if ($BrowserLogin) {
  Invoke-BrowserLogin
}

if ([string]::IsNullOrWhiteSpace($TenancyId)) {
  $TenancyId = Read-OciProfileValue -Path $ConfigPath -ProfileName $Profile -Key "tenancy"
}

if ([string]::IsNullOrWhiteSpace($Region)) {
  $Region = Read-OciProfileValue -Path $ConfigPath -ProfileName $Profile -Key "region"
}

if ([string]::IsNullOrWhiteSpace($TenancyId)) {
  throw "Tenancy OCID was not found. Provide -TenancyId or configure it in OCI CLI profile '$Profile' at '$ConfigPath'."
}

Write-Host "OCI FOCUS bootstrap"
Write-Host "  Profile:  $Profile"
Write-Host "  Auth:     $Auth"
Write-Host "  Tenancy:  $TenancyId"
if (-not [string]::IsNullOrWhiteSpace($Region)) {
  Write-Host "  Region:   $Region"
}

try {
  $tenancy = Invoke-OciJson @("iam", "tenancy", "get", "--tenancy-id", $TenancyId)
  $tenancyName = Get-ObjectProperty -Object $tenancy.data -Names @("name")
  if (-not [string]::IsNullOrWhiteSpace($tenancyName)) {
    Write-Host "[OK] Authenticated against tenancy: $tenancyName"
  } else {
    Write-Host "[OK] Authenticated against tenancy."
  }
} catch {
  Write-Warning "Could not validate tenancy metadata. Continuing with policy/report checks. Details: $($_.Exception.Message)"
}

Ensure-UsageReportPolicy
List-FocusReports

Write-Host ""
Write-Host "Bootstrap finished."
