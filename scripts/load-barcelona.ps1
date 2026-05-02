# load-barcelona.ps1
# Basado en load-valencia.ps1 (idéntica lógica + rutas Barcelona + skip 08900U)
#  - Parsea conteos del archivo de log persistido (UTF-8)
#  - Detecta municipios ya cargados leyendo logs existentes -> backfill + resume
#  - Genera CSV con valores correctos
#  - Aborta al primer fallo (FAILED/ERROR/EXCEPTION)

$ErrorActionPreference = "Continue"

$gzDir     = "E:\canScan\cat\barcelona\08_U_23012026_CAT"
$unzipDir  = "$gzDir\unzipped"
$logsDir   = "E:\canScan\cat\barcelona\logs"
$csvPath   = "$logsDir\barcelona-summary.csv"
$parserDir = "D:\canScan\cat-parser"
$skip      = "08900U_23012026.CAT.gz"  # Barcelona capital (ya cargado en B3)

if (-not (Test-Path $unzipDir)) { New-Item -ItemType Directory -Path $unzipDir -Force | Out-Null }
if (-not (Test-Path $logsDir))  { New-Item -ItemType Directory -Path $logsDir  -Force | Out-Null }

# Reset CSV con header
"municipio_code,municipio_size_kb,buildings,typologies,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

$files = Get-ChildItem -Path $gzDir -File -Filter "*.CAT.gz" |
  Where-Object { $_.Name -ne $skip } |
  Sort-Object Length -Descending

Write-Host "Total municipios: $($files.Count) (excluye 08900U Barcelona capital)"
Write-Host "Estrategia: si existe log con 'edificios cargados' -> backfill; si no -> carga"
Write-Host "================================================================="

$totalBuildings  = 0
$totalTypologies = 0
$totalFailed     = 0
$processedOk     = 0
$skippedAlreadyLoaded = 0
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

$env:NODE_OPTIONS = "--max-old-space-size=10240"
Set-Location $parserDir

$idx = 0
foreach ($file in $files) {
  $idx++
  $code   = ($file.Name -split '_')[0]
  $sizeKB = [math]::Round($file.Length / 1KB, 1)
  $catPath = Join-Path $unzipDir ($file.BaseName)
  $logPath = Join-Path $logsDir  "$code-load.log"

  Write-Host -NoNewline ("[{0,3}/{1}] {2} ({3,8} KB) ... " -f $idx, $files.Count, $code, $sizeKB)

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

      # Ejecutar parser y persistir output a log
      $output = (& npx.cmd tsx src/index.ts $catPath --load 2>&1 | Out-String)
      $parserExit = $LASTEXITCODE
      Set-Content -Path $logPath -Value $output -Encoding utf8

      # Re-leer del archivo persistido (encoding limpio)
      $logContent = Get-Content -Path $logPath -Raw -Encoding utf8

      # LAST match (el ✅ final, no las líneas de progreso intermedias)
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
        $status = "EMPTY"  # legítimamente sin edificios >=3 unidades
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
    "OK"       { $processedOk++; $totalBuildings += $buildings; $totalTypologies += $typologies; Write-Host ("OK       {0,5}s  b={1,6}  t={2,6}" -f $secs, $buildings, $typologies) }
    "BACKFILL" { $skippedAlreadyLoaded++; $totalBuildings += $buildings; $totalTypologies += $typologies; Write-Host ("BACKFILL {0,5}s  b={1,6}  t={2,6}" -f $secs, $buildings, $typologies) }
    "EMPTY"    { $processedOk++; Write-Host ("EMPTY    {0,5}s" -f $secs) }
    default {
      $totalFailed++
      Write-Host ("{0}  -> {1}" -f $status, $errMsg)
      Write-Host ""
      Write-Host "==> ABORTANDO. Log: $logPath"
      break
    }
  }
}

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "================================================================="
Write-Host "=== RESUMEN BARCELONA (excl. 08900U) ==="
Write-Host "Procesados nuevos   : $processedOk"
Write-Host "Backfilled de logs  : $skippedAlreadyLoaded"
Write-Host "Fallidos            : $totalFailed"
Write-Host "Total buildings     : $totalBuildings"
Write-Host "Total typologies    : $totalTypologies"
Write-Host "Tiempo total        : $totalMin min"
Write-Host "CSV: $csvPath"
Write-Host ""

if ($totalFailed -gt 0) { exit 1 } else { exit 0 }
