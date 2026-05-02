# load-baleares.ps1
# Itera los 66 municipios restantes de Baleares (excluye Palma 07040U):
# descomprime .gz -> .CAT, llama al parser con --load, registra CSV, limpia.
# Si CUALQUIER municipio falla, para y reporta.

$ErrorActionPreference = "Continue"  # capturamos errores nosotros, no aborta inmediato

$gzDir     = "E:\canScan\cat\baleares\07_U_23012026_CAT"
$unzipDir  = "$gzDir\unzipped"
$logsDir   = "E:\canScan\cat\baleares\logs"
$csvPath   = "$logsDir\baleares-summary.csv"
$parserDir = "D:\canScan\cat-parser"
$skip      = "07040U_23012026.CAT.gz"  # Palma

if (-not (Test-Path $unzipDir)) { New-Item -ItemType Directory -Path $unzipDir -Force | Out-Null }
if (-not (Test-Path $logsDir))  { New-Item -ItemType Directory -Path $logsDir  -Force | Out-Null }

# Header CSV (sobreescribe si existe)
"municipio_code,municipio_size_kb,buildings,typologies,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

# Listado: todos .CAT.gz excepto Palma, ordenados por tamaño descendente
$files = Get-ChildItem -Path $gzDir -File -Filter "*.CAT.gz" |
  Where-Object { $_.Name -ne $skip } |
  Sort-Object Length -Descending

Write-Host "Total municipios a procesar: $($files.Count) (excluyendo Palma)"
Write-Host "CSV resumen: $csvPath"
Write-Host "==============================================================="

$totalBuildings  = 0
$totalTypologies = 0
$totalFailed     = 0
$processedOk     = 0
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

$env:NODE_OPTIONS = "--max-old-space-size=10240"
Set-Location $parserDir

$idx = 0
foreach ($file in $files) {
  $idx++
  $code   = ($file.Name -split '_')[0]                   # ej "07033U"
  $sizeKB = [math]::Round($file.Length / 1KB, 1)
  $catPath = Join-Path $unzipDir ($file.BaseName)        # ej "07033U_23012026.CAT"
  $logPath = Join-Path $logsDir  "$code-load.log"

  Write-Host -NoNewline ("[{0,2}/{1}] {2} ({3,7} KB) ... " -f $idx, $files.Count, $code, $sizeKB)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $status = "OK"
  $errMsg = ""
  $buildings  = 0
  $typologies = 0

  try {
    # 1) Descomprimir gzip -> .CAT
    $fs  = [System.IO.File]::OpenRead($file.FullName)
    $gz  = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
    $out = [System.IO.File]::Create($catPath)
    $gz.CopyTo($out)
    $out.Close(); $gz.Close(); $fs.Close()

    # 2) Ejecutar parser con --load
    $output = (& npx.cmd tsx src/index.ts $catPath --load 2>&1 | Out-String)
    $parserExit = $LASTEXITCODE
    Set-Content -Path $logPath -Value $output -Encoding utf8

    # 3) Parsear conteos del output (formato es-ES con "." como separador miles)
    if ($output -match '✅\s+([\d\.]+)\s+edificios\s+cargados') {
      $buildings = [int]($matches[1] -replace '\.', '')
    }
    if ($output -match '✅\s+([\d\.]+)\s+tipolog[ií]as\s+cargadas') {
      $typologies = [int]($matches[1] -replace '\.', '')
    }

    # 4) Detectar fallos
    if ($parserExit -ne 0) {
      $status = "FAILED"; $errMsg = "Parser exit code $parserExit"
    } elseif ($output -match 'Error fatal:') {
      $status = "ERROR"; $errMsg = "Error fatal en parser"
    } elseif ($buildings -eq 0 -and ($output -match '0 edificios cargados')) {
      # No es necesariamente error: municipios sin edificios >=3 unidades
      $status = "EMPTY"; $errMsg = ""
    }
  } catch {
    $status = "EXCEPTION"
    $errMsg = ($_.Exception.Message -replace ',', ';' -replace "`n", ' ' -replace "`r", '').Substring(0, [Math]::Min(200, $_.Exception.Message.Length))
  } finally {
    # 5) Limpiar .CAT descomprimido (libera espacio para los siguientes)
    if (Test-Path $catPath) { Remove-Item $catPath -Force -ErrorAction SilentlyContinue }
  }

  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  # 6) Append CSV (escapando comillas en errMsg)
  $errEsc = $errMsg -replace '"', '""'
  "$code,$sizeKB,$buildings,$typologies,$secs,$status,`"$errEsc`"" |
    Add-Content -Path $csvPath -Encoding utf8

  # 7) Reportar y decidir si seguir
  if ($status -eq "OK" -or $status -eq "EMPTY") {
    Write-Host ("{0} {1,6}s  b={2,6}  t={3,6}" -f $status, $secs, $buildings, $typologies)
    $processedOk++
    $totalBuildings  += $buildings
    $totalTypologies += $typologies
  } else {
    Write-Host ("{0}  -> {1}" -f $status, $errMsg)
    $totalFailed++
    Write-Host ""
    Write-Host "==> ABORTANDO. Log del fallo: $logPath"
    break
  }
}

$swTotal.Stop()
$totalMin = [math]::Round($swTotal.Elapsed.TotalMinutes, 1)

Write-Host ""
Write-Host "==============================================================="
Write-Host "=== RESUMEN ==="
Write-Host "Procesados OK : $processedOk / $($files.Count)"
Write-Host "Fallidos      : $totalFailed"
Write-Host "Buildings     : $totalBuildings"
Write-Host "Typologies    : $totalTypologies"
Write-Host "Tiempo total  : $totalMin min"
Write-Host "CSV resumen   : $csvPath"
Write-Host ""

if ($totalFailed -gt 0) { exit 1 } else { exit 0 }
