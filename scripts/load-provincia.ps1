# load-provincia.ps1 — cargador genérico por provincia (v3)
#
# Sustituye a los load-<provincia>.ps1 de la v2, que eran 46 copias del mismo
# bucle con el directorio cambiado. Aquí la provincia es un parámetro.
#
# QUÉ CAMBIA RESPECTO A LA v2, y por qué
#
#   1) ESTADOS. La v2 marcaba `OK` en cuanto el parser salía con código 0,
#      aunque Supabase hubiera rechazado TODOS los lotes. Eso produjo 14
#      municipios de Burgos con edificios y cero tipologías, y los hizo
#      invisibles: en el CSV ponía OK. Ahora hay seis estados y `SIN_CARGA`
#      cubre justo ese caso.
#
#   2) EXPECTATIVAS. Se registran `edificios_esperados` y
#      `tipologias_esperadas` además de lo cargado. Sin el par no se puede
#      distinguir "no había nada que cargar" de "se perdió todo", que es
#      exactamente la distinción que faltó en junio.
#
#   3) CORTE POR TIEMPO. 180 s. El p97 de la corrida nacional fue 120 s, pero
#      ~15 de esos segundos eran el censo global que corría por municipio y
#      que ya se ha sacado del bucle. Con eso fuera, 180 s deja margen de
#      sobra para el municipio sano más grande (Murcia capital: 32 MB, 651 s
#      en junio, la mayoría censo y red).
#
#   4) SLEEP 250 ms en vez de los 3 s de la v2. Se bajó primero a 1 s y se
#      validó con Soria entera —183 municipios seguidos— antes de llegar aquí.
#      La evidencia es el pico de memoria POR PROCESO, que no depende de lo
#      que haga el resto de la máquina: 363 MB en el primer tercio (Soria
#      capital, que va primera porque se ordena por tamaño) y luego plano en
#      132 MB los otros dos tercios, con pendiente de −8,75 MB/min. No sube.
#      La memoria libre del SISTEMA es un proxy contaminado —oscila ±600 MB
#      con el navegador abierto— y no sirve para decidir esto.
#      Control adicional: 15 municipios de Granada SIN sleep ninguno dejaron
#      la memoria libre en 5,70 GB partiendo de 5,53 GB.
#      La cascada que motivó los 3 s era el índice global de parcelas del
#      agrupador, que 1e99a08 eliminó. El sleep sobrevivió a su causa.
#
#   5) ARRANQUE. `node node_modules/tsx/dist/cli.mjs` en vez de `npx.cmd tsx`:
#      mismo transpilador, sin la resolución de paquete de npx. Medido 0,49 s
#      frente a 1,54 s. (No se usa `node --experimental-strip-types`, que
#      sería aún más rápido, porque el proyecto es CommonJS con imports ESM
#      sin extensión y habría que convertirlo entero a ESM.)
#
#   6) CENSO. Una vez al terminar la provincia, con `--census`, en vez de una
#      vez por municipio.
#
# Uso:
#   .\scripts\load-provincia.ps1 -Provincia soria -GzDir "E:\canScan\cat\Soria\42_U_23012026_CAT"
#   .\scripts\load-provincia.ps1 -Provincia soria -GzDir "..." -DryRun
#   .\scripts\load-provincia.ps1 -Provincia soria -GzDir "..." -SoloCodigos 42001U,42002U

param(
  [Parameter(Mandatory = $true)] [string] $Provincia,
  [Parameter(Mandatory = $true)] [string] $GzDir,
  [string]   $LogsDir     = "",
  [int]      $TimeoutSeg  = 180,
  [int]      $SleepMs     = 250,
  [string[]] $SoloCodigos = @(),
  [string[]] $Excluir     = @(),
  [switch]   $DryRun
)

$ErrorActionPreference = "Continue"
$env:NODE_OPTIONS = "--max-old-space-size=10240"

$parserDir = Split-Path -Parent $PSScriptRoot
$tsx       = Join-Path $parserDir "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsx)) { throw "No encuentro tsx en $tsx. ¿Falta npm install?" }

if (-not $LogsDir) { $LogsDir = Join-Path (Split-Path -Parent $GzDir) "logs" }
$unzipDir = Join-Path $GzDir "unzipped"
foreach ($d in @($LogsDir, $unzipDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$csvPath = Join-Path $LogsDir "$Provincia-summary-$stamp.csv"

# ─── Contrato del CSV ────────────────────────────────────────────────────────
# Las tres columnas nuevas respecto a la v2 son edificios_esperados,
# tipologias_esperadas y errores_lote. El estado se deriva de ellas.
"municipio_code,municipio_size_kb,edificios_esperados,edificios_cargados,tipologias_esperadas,tipologias_cargadas,errores_lote,seconds,status,error_msg" |
  Out-File -FilePath $csvPath -Encoding utf8

# ─── Los seis estados ────────────────────────────────────────────────────────
#
#   OK         exit 0, cero errores de lote, y se cargó todo lo esperado.
#   VACIO      exit 0, cero errores, y no había nada que cargar. NO es un
#              fallo: son municipios donde ninguna parcela llega al umbral de
#              3 unidades. Separado de OK a propósito, para que 176 parcelas
#              descartadas no se confundan nunca con 176 parcelas perdidas.
#   PARCIAL    se cargó algo, pero menos de lo esperado, o hubo errores de
#              lote con carga > 0.
#   SIN_CARGA  había algo que cargar y se cargó CERO. El caso de Burgos.
#   ABORTADO   superó $TimeoutSeg y lo matamos.
#   FALLIDO    exit ≠ 0, "Error fatal:" en la salida, o el gate de validación
#              del layout abortó la corrida.
#
# Se reencolan los cuatro últimos.
$REENCOLABLES = @("PARCIAL", "SIN_CARGA", "ABORTADO", "FALLIDO")

function Get-Int([string]$texto, [string]$patron) {
  $m = [regex]::Matches($texto, $patron)
  if ($m.Count -eq 0) { return $null }
  return [int]($m[$m.Count - 1].Groups[1].Value -replace '\.', '')
}

function Invoke-Municipio {
  param([System.IO.FileInfo]$file, [string]$etiqueta, [switch]$UltimoDeLaProvincia)

  $code    = ($file.Name -split '_')[0]
  $sizeKB  = [math]::Round($file.Length / 1KB, 1)
  $cat     = Join-Path $unzipDir ($file.BaseName)
  $logPath = Join-Path $LogsDir "$code-load.log"

  Write-Host -NoNewline ("{0} {1} ({2,9} KB) ... " -f $etiqueta, $code, $sizeKB)

  $sw       = [System.Diagnostics.Stopwatch]::StartNew()
  $status   = "OK"
  $errMsg   = ""
  $bEsp = $null; $bCar = 0; $tEsp = $null; $tCar = 0; $errLote = 0

  try {
    $fs  = [System.IO.File]::OpenRead($file.FullName)
    $gz  = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
    $out = [System.IO.File]::Create($cat)
    $gz.CopyTo($out); $out.Close(); $gz.Close(); $fs.Close()

    $argumentos = @($tsx, "src/index.ts", $cat, "--load")
    if ($DryRun)             { $argumentos += "--dry-run" }
    if ($UltimoDeLaProvincia -and -not $DryRun) { $argumentos += "--census" }

    $outFile = Join-Path $LogsDir "$code.stdout"
    $errFile = Join-Path $LogsDir "$code.stderr"
    $proc = Start-Process -FilePath "node" -ArgumentList $argumentos `
              -WorkingDirectory $parserDir -NoNewWindow -PassThru `
              -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    # ⚠️ Tocar .Handle NO es decorativo. Start-Process -PassThru devuelve un
    # Process cuyo handle .NET se cierra al salir el proceso si nadie lo ha
    # retenido, y entonces ExitCode se queda vacío: todos los municipios
    # saldrían FALLIDO con "exit " sin código. Leer .Handle lo cachea.
    $null = $proc.Handle

    if (-not $proc.WaitForExit($TimeoutSeg * 1000)) {
      # Por encima de este umbral no es cómputo: es red. Matar y reencolar
      # sale más barato que dejarlo reintentar (en junio hubo un municipio
      # de 37 KB que estuvo 8,3 horas reintentando contra Supabase).
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      $status = "ABORTADO"
      $errMsg = "superó $TimeoutSeg s"
    } else {
      # ⚠️ La sobrecarga WaitForExit(ms) devuelve el booleano pero NO deja
      # ExitCode disponible: hay que esperar de nuevo sin argumentos para
      # que el objeto se refresque. Sin esto, $proc.ExitCode viene vacío y
      # todos los municipios salen FALLIDO con "exit ".
      $proc.WaitForExit()
    }

    $salida = ""
    foreach ($f in @($outFile, $errFile)) {
      if (Test-Path $f) { $salida += (Get-Content $f -Raw -Encoding utf8) }
    }
    Set-Content -Path $logPath -Value $salida -Encoding utf8
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue

    if ($status -ne "ABORTADO") {
      $bEsp    = Get-Int $salida 'Edificios a cargar:\s*(\d[\d\.]*)'
      $tEsp    = Get-Int $salida 'Tipolog\w+ a cargar:\s*(\d[\d\.]*)'
      $b       = Get-Int $salida '(\d[\d\.]*)\s+edificios\s+cargados'
      $t       = Get-Int $salida '(\d[\d\.]*)\s+tipolog\w+\s+cargad\w+'
      if ($null -ne $b) { $bCar = $b }
      if ($null -ne $t) { $tCar = $t }
      # "Error batch" es del loader; "fetch failed" y "statement timeout" son
      # de red. La validación de ida y vuelta ya no genera falsos positivos:
      # el censo global salió del bucle.
      $errLote = ([regex]::Matches($salida, 'Error batch|fetch failed|statement timeout')).Count

      if ($proc.ExitCode -ne 0) {
        $status = "FALLIDO"; $errMsg = "exit $($proc.ExitCode)"
      } elseif ($salida -match 'Error fatal:' -or $salida -match 'Corrida abortada') {
        $status = "FALLIDO"; $errMsg = "gate de validación o error fatal"
      } elseif ($null -eq $bEsp) {
        $status = "FALLIDO"; $errMsg = "no se pudo leer 'Edificios a cargar' del log"
      } elseif ($bEsp -eq 0) {
        $status = "VACIO"
      } elseif ($DryRun) {
        # En dry-run el parser imprime "Simularía insertar…" y nunca
        # "N edificios cargados", así que los contadores de carga se quedan a
        # cero por diseño. Comparar cargado contra esperado aquí marcaría
        # SIN_CARGA todos los municipios y el ensayo no serviría de nada.
        $status = "OK"
      } elseif ($bCar -eq 0) {
        $status = "SIN_CARGA"; $errMsg = "se esperaban $bEsp edificios y no se cargó ninguno"
      } elseif ($bCar -lt $bEsp -or $tCar -lt $tEsp -or $errLote -gt 0) {
        $status = "PARCIAL"; $errMsg = "cargados $bCar/$bEsp edificios, $tCar/$tEsp tipologías, $errLote errores"
      } else {
        $status = "OK"
      }
    }
  } catch {
    $status = "FALLIDO"
    $errMsg = ($_.Exception.Message -replace ',', ';' -replace "`r?`n", ' ')
    if ($errMsg.Length -gt 200) { $errMsg = $errMsg.Substring(0, 200) }
  } finally {
    if (Test-Path $cat) { Remove-Item $cat -Force -ErrorAction SilentlyContinue }
  }

  $sw.Stop()
  $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

  # Windows PowerShell 5.1 no tiene `??`; se escribe a mano.
  $bEspTxt = if ($null -eq $bEsp) { "" } else { $bEsp }
  $tEspTxt = if ($null -eq $tEsp) { "" } else { $tEsp }
  $fila = "{0},{1},{2},{3},{4},{5},{6},{7},{8},`"{9}`"" -f `
    $code, $sizeKB, $bEspTxt, $bCar, $tEspTxt, $tCar, $errLote, $secs, $status, ($errMsg -replace '"', '""')
  Add-Content -Path $csvPath -Value $fila -Encoding utf8

  $color = switch ($status) {
    "OK"        { "Green" }
    "VACIO"     { "DarkGray" }
    "PARCIAL"   { "Yellow" }
    default     { "Red" }
  }
  $bEspVis = if ($null -eq $bEsp) { "?" } else { $bEsp }
  $tEspVis = if ($null -eq $tEsp) { "?" } else { $tEsp }
  Write-Host ("{0,-10} {1,6:N1}s  edif {2}/{3}  tip {4}/{5}" -f `
    $status, $secs, $bCar, $bEspVis, $tCar, $tEspVis) -ForegroundColor $color
  if ($errMsg) { Write-Host "             └─ $errMsg" -ForegroundColor DarkYellow }

  return [pscustomobject]@{ Code = $code; Status = $status; File = $file; Seg = $secs; B = $bCar; T = $tCar }
}

# ─── Bucle principal ─────────────────────────────────────────────────────────

$files = Get-ChildItem -Path $GzDir -File -Filter "*.CAT.gz" | Sort-Object Length -Descending
if ($SoloCodigos.Count -gt 0) {
  $files = $files | Where-Object { $SoloCodigos -contains (($_.Name -split '_')[0]) }
}
if ($Excluir.Count -gt 0) {
  $files = $files | Where-Object { $Excluir -notcontains (($_.Name -split '_')[0]) }
}

Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host " provincia : $Provincia"
Write-Host " ficheros  : $($files.Count)"
Write-Host " rama      : $(git -C $parserDir rev-parse --abbrev-ref HEAD)  ($(git -C $parserDir rev-parse --short HEAD))"
Write-Host " modo      : $(if ($DryRun) { 'DRY-RUN (no escribe en Supabase)' } else { 'CARGA REAL' })"
Write-Host " corte     : $TimeoutSeg s    sleep: $SleepMs ms"
Write-Host " csv       : $csvPath"
Write-Host "═══════════════════════════════════════════════════════════════"

# El peligro no es una rama concreta: es un checkout anterior al merge que
# trajo el agrupamiento por bien inmueble. Comprobarlo por ancestro cubre
# también las ramas creadas desde un punto viejo, que la comprobación por
# nombre dejaba pasar.
$COMMIT_AGRUPAMIENTO = "30a5209"   # merge del 12-08-2026
git -C $parserDir merge-base --is-ancestor $COMMIT_AGRUPAMIENTO HEAD 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host " ⛔ Este checkout es ANTERIOR al agrupamiento por bien inmueble." -ForegroundColor Red
  Write-Host "    Cargar desde aquí parte cada bien multi-planta en una unidad" -ForegroundColor Red
  Write-Host "    por planta y deja la base con el doble de viviendas de la" -ForegroundColor Red
  Write-Host "    mitad de superficie. Actualiza a $COMMIT_AGRUPAMIENTO o posterior." -ForegroundColor Red
  exit 1
}

$resultados = @()
$i = 0
foreach ($file in $files) {
  $i++
  $ultimo = ($i -eq $files.Count)
  $resultados += Invoke-Municipio -file $file -etiqueta ("[{0,4}/{1}]" -f $i, $files.Count) -UltimoDeLaProvincia:$ultimo
  if (-not $ultimo) { Start-Sleep -Milliseconds $SleepMs }
}

# ─── Cola de reintentos ──────────────────────────────────────────────────────

$pendientes = @($resultados | Where-Object { $REENCOLABLES -contains $_.Status })
if ($pendientes.Count -gt 0) {
  Write-Host ""
  Write-Host "── reintento de $($pendientes.Count) municipio(s): $($pendientes.Code -join ', ')" -ForegroundColor Yellow
  Start-Sleep -Seconds 15
  $j = 0
  foreach ($p in $pendientes) {
    $j++
    $r = Invoke-Municipio -file $p.File -etiqueta ("[retry {0}/{1}]" -f $j, $pendientes.Count)
    $resultados = @($resultados | Where-Object { $_.Code -ne $r.Code }) + $r
    Start-Sleep -Milliseconds $SleepMs
  }
}

# ─── Resumen ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "═══════════════════ RESUMEN · $Provincia ═══════════════════"
# ⚠️ Todo el resumen sale por Write-Host, no por la tubería. Mezclar los dos
# hace que al redirigir a fichero las líneas se ENTRELACEN sin orden: en el log
# de Soria el "Sin municipios pendientes" aparecía antes que los recuentos.
foreach ($e in @("OK", "VACIO", "PARCIAL", "SIN_CARGA", "ABORTADO", "FALLIDO")) {
  # @() obliga a array: con un solo elemento, Where-Object devuelve un escalar
  # y .Count viene vacío en el -f, así que el resumen salía en blanco.
  $n = @($resultados | Where-Object { $_.Status -eq $e }).Count
  if ($n -gt 0 -or $e -eq "OK") { Write-Host ("  {0,-10} {1,5}" -f $e, $n) }
}
$segTotal = ($resultados | Measure-Object Seg -Sum).Sum
Write-Host ("  {0,-10} {1,5:N1} s ({2:N2} h)" -f "tiempo", $segTotal, ($segTotal / 3600))
Write-Host ("  {0,-10} {1,5}" -f "edificios", (($resultados | Measure-Object B -Sum).Sum))
Write-Host ("  {0,-10} {1,5}" -f "tipologías", (($resultados | Measure-Object T -Sum).Sum))
Write-Host ""
$malos = @($resultados | Where-Object { $REENCOLABLES -contains $_.Status })
if ($malos.Count -eq 0) {
  Write-Host "  ✅ Sin municipios pendientes." -ForegroundColor Green
} else {
  Write-Host "  ❌ Quedan $($malos.Count) tras el reintento: $($malos.Code -join ', ')" -ForegroundColor Red
  Write-Host "     Relánzalos con -SoloCodigos $($malos.Code -join ',')"
}
Write-Host "  csv: $csvPath"
