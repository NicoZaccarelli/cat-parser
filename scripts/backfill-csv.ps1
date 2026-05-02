# backfill-csv.ps1
# Reparsea los 66 logs de Baleares con regex robusto (sin chars con tilde,
# capturando el ultimo match para evitar lineas de progreso intermedias).

$gzDir   = "E:\canScan\cat\baleares\07_U_23012026_CAT"
$logsDir = "E:\canScan\cat\baleares\logs"
$csvPath = "$logsDir\baleares-summary.csv"
$skip    = "07040U_23012026.CAT.gz"

# Regex sin chars con tilde para evitar problemas de encoding del .ps1
$reBuildings  = [regex]::new('(\d[\d\.]*)\s+edificios\s+cargados')
$reTypologies = [regex]::new('(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+')

"municipio_code,municipio_size_kb,buildings,typologies,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

$files = Get-ChildItem -Path $gzDir -File -Filter "*.CAT.gz" |
  Where-Object { $_.Name -ne $skip } |
  Sort-Object Length -Descending

$totalBuildings = 0
$totalTypologies = 0
$totalEmpty = 0
$totalProcessed = 0

foreach ($file in $files) {
  $code   = ($file.Name -split '_')[0]
  $sizeKB = [math]::Round($file.Length / 1KB, 1)
  $logPath = Join-Path $logsDir "$code-load.log"

  $buildings = 0
  $typologies = 0
  $status = "MISSING"

  if (Test-Path $logPath) {
    $content = Get-Content -Path $logPath -Raw -Encoding utf8

    $bMatches = $reBuildings.Matches($content)
    if ($bMatches.Count -gt 0) {
      # Tomar el ULTIMO match (el del ✅ final, no las lineas de progreso)
      $last = $bMatches[$bMatches.Count - 1]
      $buildings = [int]($last.Groups[1].Value -replace '\.', '')
    }
    $tMatches = $reTypologies.Matches($content)
    if ($tMatches.Count -gt 0) {
      $last = $tMatches[$tMatches.Count - 1]
      $typologies = [int]($last.Groups[1].Value -replace '\.', '')
    }

    if ($buildings -eq 0 -and ($content -match 'Edificios a cargar: 0')) {
      $status = "EMPTY"
      $totalEmpty++
    } else {
      $status = "OK"
    }
    $totalProcessed++
  }

  $totalBuildings += $buildings
  $totalTypologies += $typologies

  "$code,$sizeKB,$buildings,$typologies,0,$status,`"`"" |
    Add-Content -Path $csvPath -Encoding utf8
}

Write-Host "=== Backfill CSV completado ==="
Write-Host "Municipios con log     : $totalProcessed / $($files.Count)"
Write-Host "Empty (0 edificios)    : $totalEmpty"
Write-Host "Buildings totales      : $totalBuildings"
Write-Host "Typologies totales     : $totalTypologies"
Write-Host "CSV: $csvPath"
