# Comprobacion en vivo del dashboard, ejecutada en el lado de Windows.
#
# Por que un script de PowerShell: en este equipo el repositorio vive en WSL y el navegador es el
# Chrome de Windows. El puerto de depuracion que abre Chrome escucha en el Windows de al lado y
# **no** es alcanzable desde WSL (el reenvio de localhost de WSL2 va solo en un sentido), asi que
# quien tiene que hablar con Chrome es un proceso de Windows. Aqui se hace con lo que ya trae
# Windows: PowerShell y .NET, sin instalar nada.
#
# Uso, desde WSL:
#   node tools/live-check.mjs                    # envoltorio: llama a este script
# o directamente desde PowerShell:
#   powershell -ExecutionPolicy Bypass -File tools\live-check.ps1 -Url http://localhost:4200
#
# Sale con codigo 0 si el informe de la pagina dice "pass".

param(
  [string]$Url = 'http://localhost:4200',
  [string]$Chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  [int]$Puerto = 9466,
  [int]$EsperaMaximaSegundos = 75,
  [string]$Captura = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Chrome)) {
  $alternativa = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  if (Test-Path $alternativa) { $Chrome = $alternativa } else { throw "No encuentro Chrome en $Chrome" }
}

$perfil = Join-Path $env:TEMP ("aggora-live-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $perfil -Force | Out-Null

$argumentos = @(
  '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--remote-allow-origins=*',
  "--remote-debugging-port=$Puerto", "--user-data-dir=$perfil",
  '--window-size=1600,1200', 'about:blank'
)

Write-Host "Comprobando la app en $Url/?verify=1"
Write-Host "  chrome: $Chrome"
$proceso = Start-Process -FilePath $Chrome -ArgumentList $argumentos -PassThru

function Esperar-Cdp {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $respuesta = Invoke-RestMethod -Uri "http://127.0.0.1:$Puerto/json/version" -TimeoutSec 3
      if ($respuesta.webSocketDebuggerUrl) { return $respuesta.webSocketDebuggerUrl }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw 'Chrome no abrio el puerto de depuracion'
}

# Cliente minimo del protocolo de DevTools sobre ClientWebSocket: sin dependencias.
function Invoke-Cdp {
  param($Socket, [int]$Id, [string]$Method, $Params = @{}, [string]$SessionId = '')

  $sobre = @{ id = $Id; method = $Method; params = $Params }
  if ($SessionId) { $sobre.sessionId = $SessionId }
  $json = $sobre | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $segmento = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
  $Socket.SendAsync($segmento, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()

  # Lee hasta encontrar la respuesta con ese id (los eventos no traen id).
  $buffer = New-Object byte[] 1048576
  while ($true) {
    $ms = New-Object System.IO.MemoryStream
    do {
      $segmentoLectura = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
      $resultado = $Socket.ReceiveAsync($segmentoLectura, [Threading.CancellationToken]::None).Result
      $ms.Write($buffer, 0, $resultado.Count)
    } while (-not $resultado.EndOfMessage)

    $texto = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    $mensaje = $texto | ConvertFrom-Json
    if ($mensaje.id -eq $Id) { return $mensaje }
  }
}

function Get-DomTexto {
  param($Socket, [int]$Id, [string]$SessionId)
  $resultado = Invoke-Cdp -Socket $Socket -Id $Id -Method 'Runtime.evaluate' -SessionId $SessionId -Params @{
    expression = 'document.body.innerText'; returnByValue = $true
  }
  return $resultado.result.result.value
}

$script:id = 0
$socket = $null
try {
  $wsUrl = Esperar-Cdp
  Write-Host "  CDP: $wsUrl"

  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.Options.SetRequestHeader('Origin', "http://127.0.0.1:$Puerto")
  $socket.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()

  $script:id++; $destino = Invoke-Cdp -Socket $socket -Id $script:id -Method 'Target.createTarget' -Params @{ url = 'about:blank' }
  $script:id++; $adjunto = Invoke-Cdp -Socket $socket -Id $script:id -Method 'Target.attachToTarget' -Params @{ targetId = $destino.result.targetId; flatten = $true }
  $sesion = $adjunto.result.sessionId
  $script:id++; Invoke-Cdp -Socket $socket -Id $script:id -Method 'Page.enable' -SessionId $sesion | Out-Null
  $script:id++; Invoke-Cdp -Socket $socket -Id $script:id -Method 'Runtime.enable' -SessionId $sesion | Out-Null
  $script:id++; Invoke-Cdp -Socket $socket -Id $script:id -Method 'Page.navigate' -SessionId $sesion -Params @{ url = "$Url/?verify=1" } | Out-Null

  # Espera a que la propia pagina termine su verificacion.
  $limite = (Get-Date).AddSeconds($EsperaMaximaSegundos)
  $texto = ''
  while ((Get-Date) -lt $limite) {
    Start-Sleep -Seconds 3
    $script:id++
    try { $texto = Get-DomTexto -Socket $socket -Id $script:id -SessionId $sesion } catch { $texto = '' }
    if ($texto -match 'failures: \d+ of') { break }
  }

  if ($Captura) {
    $script:id++
    $captura = Invoke-Cdp -Socket $socket -Id $script:id -Method 'Page.captureScreenshot' -SessionId $sesion -Params @{ format = 'png'; captureBeyondViewport = $true }
    [System.IO.File]::WriteAllBytes($Captura, [Convert]::FromBase64String($captura.result.data))
    Write-Host "  captura guardada en $Captura"
  }

  Write-Host ''
  Write-Host $texto
  Write-Host ''

  if ($texto -match 'failures: (\d+) of (\d+)') {
    $fallos = [int]$Matches[1]
    if ($fallos -eq 0) { Write-Host 'Verificacion en verde.'; exit 0 }
    Write-Host "Verificacion en rojo: $fallos fallos."
    exit 1
  }

  Write-Host 'No encontre el informe de verificacion en la pagina.'
  exit 1
} finally {
  if ($socket -and $socket.State -eq 'Open') { $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'fin', [Threading.CancellationToken]::None).Wait() }
  if ($proceso -and -not $proceso.HasExited) { $proceso.Kill() }
  if (Test-Path $perfil) { Remove-Item -Recurse -Force $perfil -ErrorAction SilentlyContinue }
}
