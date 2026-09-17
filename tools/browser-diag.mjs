#!/usr/bin/env node
/**
 * Diagnostico en un navegador de verdad, en un solo comando.
 *
 * Por que existe: cuando el sintoma es "la pagina no carga datos", mirar la consola y la pestana
 * Network es la unica forma de separar "no llega la respuesta" de "la respuesta llega y la pagina no
 * la procesa". En este equipo eso era incomodo: el navegador corre en Windows, WSL no alcanza su
 * puerto de depuracion, y el volcado de DOM (`--dump-dom`, `tools/dump-dom.mjs`) sale antes de que la
 * app termine de pedir nada.
 *
 * Esto lo junta todo:
 *   1. sirve la app compilada y hace de proxy          (`tools/serve-verify.mjs`)
 *   2. lanza el navegador de Windows con depuracion    (Edge o Chrome, desde WSL)
 *   3. pone ese puerto al alcance de WSL               (`tools/tcp-relay.mjs`)
 *   4. navega, escucha consola y red, **recarga** y mide (`tools/cdp-experiment.mjs`)
 *   5. recoge y cierra lo que abrio
 *
 * Uso:
 *   npm run diag:browser                        # abre la app en el puerto 4300 y la mide
 *   node tools/browser-diag.mjs --puerto=4301 --fase=15000
 *   node tools/browser-diag.mjs --url=http://localhost:4300/?diag=1
 *
 * Requiere el backend levantado (es lo que se quiere medir) y `npm run build` hecho.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argumento = (nombre, porDefecto) => {
  const encontrado = process.argv.find((arg) => arg.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.split('=')[1] : porDefecto;
};

const PUERTO_APP = Number(argumento('puerto', 4300));
const FASE_MS = Number(argumento('fase', 11000));
const URL_APP = argumento('url', `http://localhost:${PUERTO_APP}/?diag=1`);
const ESPERA_ARRANQUE_MS = Number(argumento('espera', 8000));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hijos = [];

function limpiar() {
  for (const hijo of hijos) {
    try {
      hijo.kill('SIGKILL');
    } catch {
      /* ya estaba muerto */
    }
  }
}

process.on('SIGINT', () => {
  limpiar();
  process.exit(130);
});
process.on('exit', limpiar);

/** Encuentra un navegador Chromium: en Windows, visto desde WSL. */
function encontrarNavegador() {
  const candidatos = [
    process.env.CHROME_BIN,
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidatos.find((ruta) => {
    try {
      return existsSync(ruta);
    } catch {
      return false;
    }
  });
}

/** Carpeta de perfil nueva: un perfil sucio cambia el comportamiento (cache, sesion). */
function perfilNuevo() {
  const carpeta = join(tmpdir(), `aggora-diag-${Date.now()}`);
  mkdirSync(carpeta, { recursive: true });
  if (process.platform !== 'win32' && !carpeta.startsWith('/mnt/')) {
    // El navegador de Windows no entiende una ruta Linux: se traduce.
    const traducida = spawnSync('wslpath', ['-w', carpeta], { encoding: 'utf8' });
    if (traducida.status === 0) {
      return traducida.stdout.trim();
    }
  }
  return carpeta;
}

const PUERTO_CDP_WINDOWS = 9222;
const PUERTO_CDP_WSL = 9223;

async function principal() {
  const navegador = encontrarNavegador();
  if (!navegador) {
    console.error('[diag] no encontre navegador; exporta CHROME_BIN');
    process.exit(2);
  }

  // 1. El puente que sirve la app compilada y proxya el backend.
  console.log(`[diag] sirviendo la app compilada en http://localhost:${PUERTO_APP}`);
  const puente = spawn(process.execPath, ['tools/serve-verify.mjs', String(PUERTO_APP)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hijos.push(puente);
  const logPuente = [];
  puente.stdout.on('data', (dato) => logPuente.push(String(dato)));
  puente.stderr.on('data', (dato) => logPuente.push(String(dato)));
  await dormir(1500);

  // 2. El navegador, con su puerto de depuracion.
  const perfil = perfilNuevo();
  console.log(`[diag] navegador: ${navegador}`);
  const browser = spawn(
    navegador,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PUERTO_CDP_WINDOWS}`,
      `--user-data-dir=${perfil}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  hijos.push(browser);
  await dormir(ESPERA_ARRANQUE_MS);

  // 3. El rele: el puerto de depuracion de Windows no se alcanza desde WSL.
  console.log(`[diag] rele 127.0.0.1:${PUERTO_CDP_WSL} -> Windows:${PUERTO_CDP_WINDOWS}`);
  const rele = spawn(
    process.execPath,
    ['tools/tcp-relay.mjs', String(PUERTO_CDP_WSL), String(PUERTO_CDP_WINDOWS)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  hijos.push(rele);
  rele.stderr.on('data', (dato) => process.stderr.write(`[rele] ${dato}`));
  await dormir(1500);

  // 4. El experimento: consola, red, sesion fresca y recarga.
  const experimento = spawnSync(
    process.execPath,
    ['tools/cdp-experiment.mjs', URL_APP, String(PUERTO_CDP_WSL), String(FASE_MS)],
    { stdio: 'inherit' },
  );

  // 5. Limpieza y resumen del puente (dice que pidio el navegador y que contesto el backend).
  limpiar();
  await dormir(500);
  const log = logPuente.join('');
  const peticiones = (log.match(/\[bridge\] -> /g) ?? []).length;
  const respuestas = (log.match(/\[bridge\] <- 200/g) ?? []).length;
  console.log(`\n[diag] el puente registro ${peticiones} peticiones y ${respuestas} respuestas 200`);
  const sinRespuesta = (log.match(/\[bridge\] <- (4\d\d|5\d\d)/g) ?? []).length;
  if (sinRespuesta > 0) {
    console.log(`[diag] respuestas no-200 del backend: ${sinRespuesta}`);
  }
  const archivo = join(tmpdir(), 'aggora-bridge.log');
  writeFileSync(archivo, log);
  console.log(`[diag] log completo del puente en ${archivo}`);
  try {
    if (perfil.startsWith('C:')) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -Recurse -Force '${perfil}'`]);
    } else {
      rmSync(perfil, { recursive: true, force: true });
    }
  } catch {
    /* el perfil temporal se puede quedar: no importa */
  }

  process.exit(experimento.status ?? 0);
}

principal().catch((error) => {
  console.error('[diag] fallo:', error);
  limpiar();
  process.exit(1);
});
