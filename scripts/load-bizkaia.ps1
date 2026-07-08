# load-bizkaia.ps1 (Fase 1 - carga foral Bizkaia via BFA GML)
#
# Diferencias vs load-madrid.ps1 (DGC nacional):
#   - Los archivos son .zip (no .CAT.gz); el loader los descomprime internamente
#     con unzipper — no hay que gunzip aquí.
#   - Se invoca `src/loader-bizkaia/index.ts <cod3>` (no un path a .cat).
#   - DETENERSE al primer FAILED (per prompt del user).
#   - Backfill: log por municipio con "edificios cargados" indica ya cargado.

$ErrorActionPreference = "Continue"

$zipDir    = "E:\canScan\cat\Bizkaia\catastro"
$logsDir   = "E:\canScan\cat\Bizkaia\logs"
$csvPath   = "$logsDir\bizkaia-summary.csv"
$parserDir = "D:\canScan\cat-parser"

if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

# Reset CSV con header
"municipio_code,municipio_size_kb,buildings,typologies,geoms,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

# Municipios ordenados por código (001 → 916).
$files = Get-ChildItem -Path $zipDir -File -Filter "*.zip" |
  Sort-Object { ($_.Name -split '_')[0] }

Write-Host "Total municipios: $($files.Count) (Bizkaia foral)"
Write-Host "Estrategia: backfill via log, sleep 3s/iter, DETENERSE en primer FAILED"
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
  $code   = ($file.Name -split '_')[0]  # ej "001"
  $sizeKB = [math]::Round($file.Length / 1KB, 1)
  $logPath = Join-Path $logsDir "$code-load.log"

  Write-Host -NoNewline ("[{0,3}/{1}] {2} ({3,8} KB) ... " -f $idx, $files.Count, $code, $sizeKB)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $status = "OK"
  $errMsg = ""
  $buildings = 0
  $typologies = 0
  $geoms = 0
  $skipLoad = $false

  # BACKFILL: si el log ya tiene "N edificios cargados", saltamos.
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
      $skipLoad = $true
      $status = "BACKFILL"
    }
  }

  if (-not $skipLoad) {
    try {
      $output = (& npx.cmd tsx src/loader-bizkaia/index.ts $code 2>&1 | Out-String)
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
        $status = "FAILED"
        $errMsg = "Parser exit $parserExit"
      } elseif ($output -match 'FATAL:') {
        $status = "ERROR"
        $errMsg = "FATAL en parser"
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
  "$code,$sizeKB,$buildings,$typologies,$geoms,$secs,$status,`"$errEsc`"" |
    Add-Content -Path $csvPath -Encoding utf8

  switch ($status) {
    "OK"       {
      Write-Host ("OK       {0,5}s  b={1,6}  t={2,6}  g={3,6}" -f $secs, $buildings, $typologies, $geoms)
      $processedOk++
      $totalBuildings += $buildings
      $totalTypologies += $typologies
      $totalGeoms += $geoms
    }
    "BACKFILL" {
      Write-Host ("BACKFILL {0,5}s  b={1,6}  t={2,6}  g={3,6}" -f $secs, $buildings, $typologies, $geoms)
      $skippedAlreadyLoaded++
      $totalBuildings += $buildings
      $totalTypologies += $typologies
      $totalGeoms += $geoms
    }
    default {
      Write-Host ("{0}  -> {1}" -f $status, $errMsg)
      $failedCode = $code
      break
    }
  }

  if ($failedCode) { break }

  Start-Sleep -Seconds 3
}

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "================================================================="
Write-Host "=== RESUMEN BIZKAIA (FASE 1 foral) ==="
Write-Host "Procesados nuevos OK : $processedOk"
Write-Host "Backfilled de logs   : $skippedAlreadyLoaded"
Write-Host "Total buildings      : $totalBuildings"
Write-Host "Total typologies     : $totalTypologies"
Write-Host "Total geometrías     : $totalGeoms"
Write-Host "Tiempo total         : $totalMin min"
Write-Host "CSV: $csvPath"
if ($failedCode) {
  Write-Host ""
  Write-Host "*** DETENIDO en municipio $failedCode ***"
  Write-Host "Revisa $logsDir\$failedCode-load.log y $csvPath antes de continuar."
  exit 1
}

Write-Host ""
Write-Host "OK todos los municipios."
exit 0
