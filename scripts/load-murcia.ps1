# load-murcia.ps1 (basado en load-madrid.ps1 v2 endurecido + loader v3 batch=50)
# Mitigaciones contra cascada ambiental (Madrid + Alicante + Málaga: 0 FAILED):
#   1) Sleep 3s entre iteraciones para que el SO libere handles/memoria.
#   2) NO aborta al primer FAILED. Loguea, suma a $failedCodes y continúa.
#   3) Cola de retry al final del bucle (sleep 30s + 5s entre retries).
#   4) Backoff 5s extra antes de iteración tras FAILED previo.

$ErrorActionPreference = "Continue"

$gzDir     = "E:\canScan\cat\murcia\30_U_23012026_CAT"
$unzipDir  = "$gzDir\unzipped"
$logsDir   = "E:\canScan\cat\murcia\logs"
$csvPath   = "$logsDir\murcia-summary.csv"
$parserDir = "D:\canScan\cat-parser"
$skip      = ""  # Murcia sin carga previa: no se salta ningún archivo

if (-not (Test-Path $unzipDir)) { New-Item -ItemType Directory -Path $unzipDir -Force | Out-Null }
if (-not (Test-Path $logsDir))  { New-Item -ItemType Directory -Path $logsDir  -Force | Out-Null }

# Reset CSV con header
"municipio_code,municipio_size_kb,buildings,typologies,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

$files = Get-ChildItem -Path $gzDir -File -Filter "*.CAT.gz" |
  Where-Object { $_.Name -ne $skip } |
  Sort-Object Length -Descending

Write-Host "Total municipios: $($files.Count) (Murcia completa, sin skips)"
Write-Host "Estrategia: BACKFILL desde logs · sleep 3s/iter · backoff 5s tras FAILED · retry final"
Write-Host "================================================================="

$totalBuildings  = 0
$totalTypologies = 0
$totalFailed     = 0
$processedOk     = 0
$skippedAlreadyLoaded = 0
$failedCodes     = New-Object System.Collections.ArrayList
$lastWasFailed   = $false
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

$env:NODE_OPTIONS = "--max-old-space-size=10240"
Set-Location $parserDir

# ─────────────────────────────────────────────────────────────────────────
# Bucle principal
# ─────────────────────────────────────────────────────────────────────────

function Invoke-LoadMunicipio {
  param(
    [System.IO.FileInfo]$file,
    [string]$labelPrefix
  )

  $code   = ($file.Name -split '_')[0]
  $sizeKB = [math]::Round($file.Length / 1KB, 1)
  $catPath = Join-Path $unzipDir ($file.BaseName)
  $logPath = Join-Path $logsDir  "$code-load.log"

  Write-Host -NoNewline ("{0} {1} ({2,8} KB) ... " -f $labelPrefix, $code, $sizeKB)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $status = "OK"
  $errMsg = ""
  $buildings = 0
  $typologies = 0
  $skipLoad = $false

  # CHECK: ¿ya hay log con carga válida?
  if (Test-Path $logPath) {
    $existing = Get-Content -Path $logPath -Raw -Encoding utf8
    if ($existing -match '(\d[\d\.]*)\s+edificios\s+cargados') {
      $buildings = [int]($matches[1] -replace '\.', '')
      if ($existing -match '(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+') {
        $typologies = [int]($matches[1] -replace '\.', '')
      }
      $skipLoad = $true
      $status = "BACKFILL"
    }
  }

  if (-not $skipLoad) {
    try {
      # Descomprimir
      $fs  = [System.IO.File]::OpenRead($file.FullName)
      $gz  = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
      $out = [System.IO.File]::Create($catPath)
      $gz.CopyTo($out)
      $out.Close(); $gz.Close(); $fs.Close()

      $output = (& npx.cmd tsx src/index.ts $catPath --load 2>&1 | Out-String)
      $parserExit = $LASTEXITCODE
      Set-Content -Path $logPath -Value $output -Encoding utf8

      $logContent = Get-Content -Path $logPath -Raw -Encoding utf8

      $reB = [regex]::new('(\d[\d\.]*)\s+edificios\s+cargados')
      $reT = [regex]::new('(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+')
      $bMatches = $reB.Matches($logContent)
      if ($bMatches.Count -gt 0) {
        $buildings = [int]($bMatches[$bMatches.Count - 1].Groups[1].Value -replace '\.', '')
      }
      $tMatches = $reT.Matches($logContent)
      if ($tMatches.Count -gt 0) {
        $typologies = [int]($tMatches[$tMatches.Count - 1].Groups[1].Value -replace '\.', '')
      }

      if ($parserExit -ne 0) {
        $status = "FAILED"; $errMsg = "Parser exit $parserExit"
      } elseif ($logContent -match 'Error fatal:') {
        $status = "ERROR"; $errMsg = "Error fatal en parser"
      } elseif ($buildings -eq 0 -and ($logContent -match 'Edificios a cargar: 0')) {
        $status = "EMPTY"
      }
    } catch {
      $status = "EXCEPTION"
      $errMsg = ($_.Exception.Message -replace ',', ';' -replace "`n", ' ' -replace "`r", '')
      if ($errMsg.Length -gt 200) { $errMsg = $errMsg.Substring(0, 200) }
    } finally {
      if (Test-Path $catPath) { Remove-Item $catPath -Force -ErrorAction SilentlyContinue }
    }
  }

  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  $errEsc = $errMsg -replace '"', '""'
  "$code,$sizeKB,$buildings,$typologies,$secs,$status,`"$errEsc`"" |
    Add-Content -Path $csvPath -Encoding utf8

  switch ($status) {
    "OK"       { Write-Host ("OK       {0,5}s  b={1,6}  t={2,6}" -f $secs, $buildings, $typologies) }
    "BACKFILL" { Write-Host ("BACKFILL {0,5}s  b={1,6}  t={2,6}" -f $secs, $buildings, $typologies) }
    "EMPTY"    { Write-Host ("EMPTY    {0,5}s" -f $secs) }
    default    { Write-Host ("{0}  -> {1}" -f $status, $errMsg) }
  }

  return [PSCustomObject]@{
    Code = $code
    Status = $status
    Buildings = $buildings
    Typologies = $typologies
    SizeKB = $sizeKB
    File = $file
  }
}

$idx = 0
foreach ($file in $files) {
  $idx++

  # Backoff adicional si la iteración previa falló (mitiga cascada ambiental)
  if ($lastWasFailed) {
    Write-Host "  (backoff 5s tras FAILED previo)"
    Start-Sleep -Seconds 5
  }

  $label = ("[{0,3}/{1}]" -f $idx, $files.Count)
  $r = Invoke-LoadMunicipio -file $file -labelPrefix $label

  switch ($r.Status) {
    "OK"       { $processedOk++; $totalBuildings += $r.Buildings; $totalTypologies += $r.Typologies; $lastWasFailed = $false }
    "BACKFILL" { $skippedAlreadyLoaded++; $totalBuildings += $r.Buildings; $totalTypologies += $r.Typologies; $lastWasFailed = $false }
    "EMPTY"    { $processedOk++; $lastWasFailed = $false }
    default    { $totalFailed++; [void]$failedCodes.Add($r); $lastWasFailed = $true }
  }

  # Pequeño sleep entre iteraciones para que el SO libere recursos
  Start-Sleep -Seconds 3
}

# ─────────────────────────────────────────────────────────────────────────
# Cola de retry para los FAILED
# ─────────────────────────────────────────────────────────────────────────

$retriedOk     = 0
$stillFailed   = New-Object System.Collections.ArrayList

if ($totalFailed -gt 0) {
  Write-Host ""
  Write-Host "================================================================="
  Write-Host "Reintentando $totalFailed municipios fallidos (sleep 30s previo)..."
  Start-Sleep -Seconds 30

  $retryIdx = 0
  foreach ($prev in $failedCodes) {
    $retryIdx++
    # El log del fallo previo está sin "edificios cargados" así que BACKFILL no
    # le aplica; lo borramos por higiene para que el retry produzca log limpio.
    $logPath = Join-Path $logsDir "$($prev.Code)-load.log"
    if (Test-Path $logPath) { Remove-Item $logPath -Force -ErrorAction SilentlyContinue }

    $label = ("[retry {0,2}/{1}]" -f $retryIdx, $totalFailed)
    $r2 = Invoke-LoadMunicipio -file $prev.File -labelPrefix $label

    switch ($r2.Status) {
      "OK"       { $retriedOk++; $totalBuildings += $r2.Buildings; $totalTypologies += $r2.Typologies }
      "BACKFILL" { $retriedOk++; $totalBuildings += $r2.Buildings; $totalTypologies += $r2.Typologies }
      "EMPTY"    { $retriedOk++ }
      default    { [void]$stillFailed.Add($r2) }
    }

    Start-Sleep -Seconds 5
  }
}

# ─────────────────────────────────────────────────────────────────────────
# Resumen final
# ─────────────────────────────────────────────────────────────────────────

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "================================================================="
Write-Host "=== RESUMEN MURCIA ==="
Write-Host "Procesados nuevos OK : $processedOk"
Write-Host "Backfilled de logs   : $skippedAlreadyLoaded"
Write-Host "Fallidos en 1ª pasada: $totalFailed"
Write-Host "Recuperados en retry : $retriedOk"
Write-Host "Aún fallidos         : $($stillFailed.Count)"
Write-Host "Total buildings      : $totalBuildings"
Write-Host "Total typologies     : $totalTypologies"
Write-Host "Tiempo total         : $totalMin min"
Write-Host "CSV: $csvPath"
Write-Host ""

if ($stillFailed.Count -gt 0) {
  Write-Host "Municipios aún fallidos tras retry:"
  foreach ($f in $stillFailed) {
    Write-Host ("  - {0} ({1,8} KB)" -f $f.Code, $f.SizeKB)
  }
}

if ($stillFailed.Count -gt 0) { exit 1 } else { exit 0 }
