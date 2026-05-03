# load-malaga-fix-final.ps1
# Re-carga 25 municipios de Málaga con el loader actualizado:
#   - batchSize: 500 → 50 (cada insert HTTP <8s siempre)
#   - retry interno con backoff (0s/2s/5s) en cada batch
# Idempotente: clearTypologiesFor borra parciales antes de re-insertar.

$ErrorActionPreference = "Continue"

$gzDir     = "E:\canScan\cat\malaga\29_U_23012026_CAT"
$unzipDir  = "$gzDir\unzipped"
$logsDir   = "E:\canScan\cat\malaga\logs"
$csvPath   = "$logsDir\malaga-fix-final-summary.csv"
$parserDir = "D:\canScan\cat-parser"

# 17 originales (de la primera detección por t=0 en CSV original)
# + 8 nuevos detectados en find-low-ratio (con typologies parciales)
$affectedCodes = @(
  # Originales
  "29056U", "29098U", "29028U", "29047U", "29003U",
  "29087U", "29030U", "29036U", "29006U", "29092U",
  "29101U", "29024U", "29022U", "29081U", "29066U",
  "29016U", "29085U",
  # Nuevos detectados (ratios <1.5x)
  "29063U", "29045U", "29053U", "29004U", "29055U",
  "29027U", "29014U", "29040U"
)

if (-not (Test-Path $unzipDir)) { New-Item -ItemType Directory -Path $unzipDir -Force | Out-Null }
if (-not (Test-Path $logsDir))  { New-Item -ItemType Directory -Path $logsDir  -Force | Out-Null }

"municipio_code,municipio_size_kb,buildings,typologies,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

$files = Get-ChildItem -Path $gzDir -File -Filter "*.CAT.gz" | Where-Object {
  $code = ($_.Name -split '_')[0]
  $affectedCodes -contains $code
} | Sort-Object Length -Descending

Write-Host "Modo FIX-FINAL: $($files.Count) municipios (esperado: 25)"
Write-Host "Loader actualizado: batchSize=50, retry 0/2/5s"
Write-Host "================================================================="

$totalBuildings  = 0
$totalTypologies = 0
$totalFailed     = 0
$processedOk     = 0
$failedCodes     = New-Object System.Collections.ArrayList
$lastWasFailed   = $false
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

$env:NODE_OPTIONS = "--max-old-space-size=10240"
Set-Location $parserDir

function Invoke-LoadMunicipio {
  param([System.IO.FileInfo]$file, [string]$labelPrefix)

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

  try {
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
    } elseif ($typologies -eq 0 -and $buildings -gt 0) {
      $status = "FAILED"; $errMsg = "Typologies = 0 pero buildings > 0 (timeout repitiéndose)"
    } elseif ($logContent -match 'errores\)\s*$') {
      # Detectar partial loads (ej. "✅ 500 tipologías cargadas (1368 errores)")
      if ($logContent -match '(\d+)\s+errores') {
        $errCount = [int]$matches[1]
        if ($errCount -gt 0) {
          $status = "PARTIAL"; $errMsg = "$errCount errores en typology inserts"
        }
      }
    }
  } catch {
    $status = "EXCEPTION"
    $errMsg = ($_.Exception.Message -replace ',', ';' -replace "`n", ' ' -replace "`r", '')
    if ($errMsg.Length -gt 200) { $errMsg = $errMsg.Substring(0, 200) }
  } finally {
    if (Test-Path $catPath) { Remove-Item $catPath -Force -ErrorAction SilentlyContinue }
  }

  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  $errEsc = $errMsg -replace '"', '""'
  "$code,$sizeKB,$buildings,$typologies,$secs,$status,`"$errEsc`"" |
    Add-Content -Path $csvPath -Encoding utf8

  switch ($status) {
    "OK"      { Write-Host ("OK       {0,5}s  b={1,6}  t={2,6}" -f $secs, $buildings, $typologies) }
    "PARTIAL" { Write-Host ("PARTIAL  {0,5}s  b={1,6}  t={2,6}  ({3})" -f $secs, $buildings, $typologies, $errMsg) }
    default   { Write-Host ("{0}  -> {1}" -f $status, $errMsg) }
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
  if ($lastWasFailed) {
    Write-Host "  (backoff 5s tras FAILED previo)"
    Start-Sleep -Seconds 5
  }
  $label = ("[{0,2}/{1}]" -f $idx, $files.Count)
  $r = Invoke-LoadMunicipio -file $file -labelPrefix $label

  switch ($r.Status) {
    "OK"      { $processedOk++; $totalBuildings += $r.Buildings; $totalTypologies += $r.Typologies; $lastWasFailed = $false }
    "PARTIAL" { $processedOk++; [void]$failedCodes.Add($r); $totalBuildings += $r.Buildings; $totalTypologies += $r.Typologies; $lastWasFailed = $true }
    default   { $totalFailed++; [void]$failedCodes.Add($r); $lastWasFailed = $true }
  }
  Start-Sleep -Seconds 3
}

# Retry queue (incluye PARTIAL para llenar typologies faltantes)
$retriedOk = 0
$stillFailed = New-Object System.Collections.ArrayList
if ($failedCodes.Count -gt 0) {
  Write-Host ""
  Write-Host "Reintentando $($failedCodes.Count) (FAILED + PARTIAL) tras sleep 30s..."
  Start-Sleep -Seconds 30
  $i = 0
  foreach ($prev in $failedCodes) {
    $i++
    $logPath = Join-Path $logsDir "$($prev.Code)-load.log"
    if (Test-Path $logPath) { Remove-Item $logPath -Force -ErrorAction SilentlyContinue }
    $r2 = Invoke-LoadMunicipio -file $prev.File -labelPrefix ("[retry {0,2}/{1}]" -f $i, $failedCodes.Count)
    if ($r2.Status -eq "OK") { $retriedOk++ }
    else { [void]$stillFailed.Add($r2) }
    Start-Sleep -Seconds 5
  }
}

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "================================================================="
Write-Host "=== RESUMEN MÁLAGA FIX-FINAL ==="
Write-Host "Procesados OK 1ª pasada     : $processedOk"
Write-Host "Fallidos+Partial 1ª pasada  : $($failedCodes.Count)"
Write-Host "Recuperados en retry        : $retriedOk"
Write-Host "Aún problemáticos           : $($stillFailed.Count)"
Write-Host "Tiempo total                : $totalMin min"
Write-Host "CSV: $csvPath"

if ($stillFailed.Count -gt 0) {
  Write-Host ""
  Write-Host "Aún problemáticos:"
  foreach ($f in $stillFailed) { Write-Host ("  - {0} [{1}]" -f $f.Code, $f.Status) }
  exit 1
}
exit 0
