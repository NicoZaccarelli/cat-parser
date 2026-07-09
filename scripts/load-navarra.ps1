# load-navarra.ps1 (Fase 3 foral)
# Batch de los 264 municipios de Navarra via zip alfanumérico + gpkg CP.
# Patrón idéntico a load-gipuzkoa.ps1.

$ErrorActionPreference = "Continue"

$zipDir    = "E:\canScan\cat\Navarra\alfanumerico"
$logsDir   = "E:\canScan\cat\Navarra\logs"
$csvPath   = "$logsDir\navarra-summary.csv"
$parserDir = "D:\canScan\cat-parser"

if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

"cod3,buildings,typologies,geoms,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

$files = Get-ChildItem -Path $zipDir -File -Filter "*_alfanumerico.zip" |
  Sort-Object Name

Write-Host "Total municipios: $($files.Count) (Navarra foral)"
Write-Host "Estrategia: backfill via log, sleep 2s/iter, DETENERSE en primer FAILED"
Write-Host "================================================================="

$totalBuildings  = 0
$totalTypologies = 0
$totalGeoms      = 0
$processedOk     = 0
$skippedAlreadyLoaded = 0
$failedCode      = $null

$env:NODE_OPTIONS = "--max-old-space-size=10240"
Set-Location $parserDir

$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

$idx = 0
foreach ($file in $files) {
  $idx++
  $code    = ($file.Name -split '_')[0]  # "183"
  $logPath = Join-Path $logsDir "$code-load.log"

  Write-Host -NoNewline ("[{0,3}/{1}] {2} ... " -f $idx, $files.Count, $code)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $status = "OK"; $errMsg = ""
  $buildings = 0; $typologies = 0; $geoms = 0
  $skipLoad = $false

  if (Test-Path $logPath) {
    $existing = Get-Content -Path $logPath -Raw -Encoding utf8
    if ($existing -match '(\d[\d\.]*)\s+edificios\s+cargados') {
      $buildings = [int]($matches[1] -replace '\.', '')
      if ($existing -match '(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+') {
        $typologies = [int]($matches[1] -replace '\.', '')
      }
      if ($existing -match 'parcel_geometries:\s*(\d+)/(\d+)') {
        $geoms = [int]$matches[1]
      }
      $skipLoad = $true; $status = "BACKFILL"
    }
  }

  if (-not $skipLoad) {
    try {
      $output = (& npx.cmd tsx src/loader-navarra/index.ts $code 2>&1 | Out-String)
      $parserExit = $LASTEXITCODE
      Set-Content -Path $logPath -Value $output -Encoding utf8

      $reB = [regex]::new('(\d[\d\.]*)\s+edificios\s+cargados')
      $reT = [regex]::new('(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+')
      $reG = [regex]::new('parcel_geometries:\s*(\d+)/(\d+)')

      $bM = $reB.Matches($output)
      if ($bM.Count -gt 0) { $buildings = [int]($bM[$bM.Count - 1].Groups[1].Value -replace '\.', '') }
      $tM = $reT.Matches($output)
      if ($tM.Count -gt 0) { $typologies = [int]($tM[$tM.Count - 1].Groups[1].Value -replace '\.', '') }
      $gM = $reG.Matches($output)
      if ($gM.Count -gt 0) { $geoms = [int]$gM[$gM.Count - 1].Groups[1].Value }

      if ($parserExit -ne 0) {
        $status = "FAILED"; $errMsg = "Parser exit $parserExit"
      } elseif ($output -match 'FATAL:') {
        $status = "ERROR"; $errMsg = "FATAL en parser"
      }
    } catch {
      $status = "EXCEPTION"
      $errMsg = ($_.Exception.Message -replace ',', ';' -replace "`n", ' ' -replace "`r", '')
      if ($errMsg.Length -gt 200) { $errMsg = $errMsg.Substring(0, 200) }
    }
  }

  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  $errEsc = $errMsg -replace '"', '""'
  "$code,$buildings,$typologies,$geoms,$secs,$status,`"$errEsc`"" |
    Add-Content -Path $csvPath -Encoding utf8

  switch ($status) {
    "OK"       { Write-Host ("OK       {0,5}s  b={1,6}  t={2,6}  g={3,6}" -f $secs, $buildings, $typologies, $geoms); $processedOk++; $totalBuildings += $buildings; $totalTypologies += $typologies; $totalGeoms += $geoms }
    "BACKFILL" { Write-Host ("BACKFILL {0,5}s  b={1,6}  t={2,6}  g={3,6}" -f $secs, $buildings, $typologies, $geoms); $skippedAlreadyLoaded++; $totalBuildings += $buildings; $totalTypologies += $typologies; $totalGeoms += $geoms }
    default    { Write-Host ("{0}  -> {1}" -f $status, $errMsg); $failedCode = $code; break }
  }

  if ($failedCode) { break }
  Start-Sleep -Seconds 2
}

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "================================================================="
Write-Host "=== RESUMEN NAVARRA (Fase 3 foral) ==="
Write-Host "Procesados nuevos OK : $processedOk"
Write-Host "Backfilled de logs   : $skippedAlreadyLoaded"
Write-Host "Total buildings      : $totalBuildings"
Write-Host "Total typologies     : $totalTypologies"
Write-Host "Total geometrias     : $totalGeoms"
Write-Host "Tiempo total         : $totalMin min"
Write-Host "CSV: $csvPath"
if ($failedCode) {
  Write-Host ""
  Write-Host "*** DETENIDO en municipio $failedCode ***"
  exit 1
}
Write-Host ""
Write-Host "OK todos los municipios."
exit 0
