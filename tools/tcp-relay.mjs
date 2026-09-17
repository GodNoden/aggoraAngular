#!/usr/bin/env node
/**
 * Rele TCP: pone un puerto de Windows al alcance de WSL.
 *
 * Por que existe: en este equipo el navegador (y su puerto de depuracion) vive en Windows, y WSL no
 * alcanza `localhost:9222` de Windows aunque Windows si alcanza el `localhost` de WSL. Eso es lo que
 * dejo al descubierto el HANDOFF: "el puerto de depuracion solo es alcanzable desde el lado de
 * Windows".
 *
 * Solucion: un proceso pequeno que escucha en WSL y, por cada conexion, lanza un PowerShell en
 * Windows que habla con el puerto de verdad y copia los bytes en los dos sentidos. No entiende el
 * protocolo; solo mueve bytes, asi que sirve igual para el `json/list` como para el WebSocket.
 *
 * Uso:
 *   node tools/tcp-relay.mjs [puertoLocal] [puertoWindows] [hostWindows]
 *   node tools/tcp-relay.mjs 9223 9222 localhost
 *
 * Limitacion conocida: cada conexion lanza un PowerShell (~300 ms de arranque). Para un puñado de
 * conexiones de depuracion es de sobra.
 */

import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';

const PUERTO_LOCAL = Number(process.argv[2] ?? 9223);
const PUERTO_WINDOWS = Number(process.argv[3] ?? 9222);
const HOST_WINDOWS = process.argv[4] ?? 'localhost';

/** Script de PowerShell: conecta al puerto de Windows y copia bytes sin interpretarlos. */
const SCRIPT_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$entrada = [Console]::OpenStandardInput()
$salida = [Console]::OpenStandardOutput()
$cliente = New-Object System.Net.Sockets.TcpClient
$cliente.Connect('${HOST_WINDOWS}', ${PUERTO_WINDOWS})
$flujo = $cliente.GetStream()
$tareaIda = $entrada.CopyToAsync($flujo)
$tareaVuelta = $flujo.CopyToAsync($salida)
[Threading.Tasks.Task]::WaitAny(@($tareaIda, $tareaVuelta)) | Out-Null
$cliente.Close()
`;

const servidor = createServer((socket) => {
  console.log(`[rele] conexion entrante -> ${HOST_WINDOWS}:${PUERTO_WINDOWS}`);
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', SCRIPT_PS],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  ps.stdout.pipe(socket);
  socket.pipe(ps.stdin);
  const cerrar = () => {
    socket.destroy();
    try {
      ps.kill();
    } catch {
      /* ya estaba muerto */
    }
  };
  socket.on('error', cerrar);
  socket.on('close', cerrar);
  ps.on('error', cerrar);
  ps.on('exit', () => socket.destroy());
});

servidor.listen(PUERTO_LOCAL, '127.0.0.1', () => {
  console.log(`[rele] escuchando en 127.0.0.1:${PUERTO_LOCAL} -> Windows ${HOST_WINDOWS}:${PUERTO_WINDOWS}`);
});
