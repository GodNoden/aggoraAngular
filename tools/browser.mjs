/**
 * Lanzar un navegador de verdad desde WSL y poder hablar con el.
 *
 * Aqui esta el trabajo incomodo, en un solo sitio, porque en este equipo tiene tres trampas:
 *
 *  1. El navegador es de Windows y el codigo vive en WSL. `--user-data-dir` tiene que ser una ruta
 *     de Windows, o arranca y muere con codigo 21.
 *  2. Su puerto de depuracion escucha en Windows y **desde WSL no se alcanza**: el reenvio de
 *     `localhost` de WSL2 va en un solo sentido. Lo pone al alcance `tools/tcp-relay.mjs`.
 *  3. Sin un perfil nuevo, la cache y la sesion anterior cambian lo que se mide.
 *
 * Lo usan `tools/live-check.mjs` (comprobar la pagina) y `tools/browser-diag.mjs` (mirar consola y
 * red). Ninguno de los dos deberia volver a `--dump-dom`: ese volcado sale antes de que la app
 * termine de pedir nada, y ya hizo perder horas.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { conectarCdp } from './cdp.mjs';

const CANDIDATOS = [
  process.env.CHROME_BIN,
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Encuentra un navegador Chromium utilizable. */
export function encontrarNavegador() {
  return CANDIDATOS.find((ruta) => {
    try {
      return existsSync(ruta);
    } catch {
      return false;
    }
  });
}

/** Carpeta de perfil nueva, traducida a ruta de Windows si hace falta. */
function perfilNuevo() {
  const carpeta = join(tmpdir(), `aggora-navegador-${Date.now()}`);
  mkdirSync(carpeta, { recursive: true });
  const traducida = spawnSync('wslpath', ['-w', carpeta], { encoding: 'utf8' });
  return traducida.status === 0 ? traducida.stdout.trim() : carpeta;
}

function borrarPerfil(perfil) {
  try {
    if (/^[A-Za-z]:/.test(perfil)) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', `Remove-Item -Recurse -Force '${perfil}'`]);
    } else {
      rmSync(perfil, { recursive: true, force: true });
    }
  } catch {
    /* el perfil temporal se puede quedar: no importa */
  }
}

/**
 * Abre un navegador con depuracion y devuelve un cliente CDP conectado a una pestaña nueva.
 *
 * `puertoWindows` es el que escucha el navegador; `puertoLocal` el del rele, que es el que se usa
 * desde aqui. El llamante **debe** llamar a `cerrar()`.
 */
export async function abrirNavegador({ puertoWindows = 9222, puertoLocal = 9223, esperaMs = 7000 } = {}) {
  const navegador = encontrarNavegador();
  if (!navegador) {
    throw new Error('no encontre navegador; exporta CHROME_BIN apuntando a tu binario');
  }
  const perfil = perfilNuevo();
  const procesoNavegador = spawn(
    navegador,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${puertoWindows}`,
      `--user-data-dir=${perfil}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const procesoRele = spawn(
    process.execPath,
    ['tools/tcp-relay.mjs', String(puertoLocal), String(puertoWindows)],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  await dormir(esperaMs);

  const respuesta = await fetch(`http://127.0.0.1:${puertoLocal}/json/new?about:blank`, { method: 'PUT' });
  const datos = await respuesta.json();
  const url = new URL(datos.webSocketDebuggerUrl);
  url.hostname = '127.0.0.1';
  url.port = String(puertoLocal);
  const cdp = conectarCdp(url.toString());
  await cdp.espera;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    cdp,
    navegador,
    cerrar() {
      try {
        cdp.cerrar();
      } catch {
        /* ya estaba cerrado */
      }
      for (const proceso of [procesoRele, procesoNavegador]) {
        try {
          proceso.kill('SIGKILL');
        } catch {
          /* ya estaba muerto */
        }
      }
      borrarPerfil(perfil);
    },
  };
}

/**
 * Espera a que la pagina se quede quieta.
 *
 * "Quieta" no es "cargo": los paneles se piden de uno en uno y tardan. Se mira el DOM hasta que el
 * numero de tarjetas con datos deja de crecer durante dos lecturas seguidas.
 */
export async function esperarEstable(cdp, { maxMs = 30000, intervaloMs = 1500 } = {}) {
  const inicio = Date.now();
  let anterior = -1;
  let estable = 0;
  let ultimo = null;
  while (Date.now() - inicio < maxMs) {
    const resultado = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        ok: document.querySelectorAll('[data-estado="ok"]').length,
        pidiendo: document.querySelectorAll('[data-estado="pidiendo"]').length,
        tarjetas: document.querySelectorAll('article.card').length
      })`,
      returnByValue: true,
    });
    ultimo = JSON.parse(resultado.result.value);
    if (ultimo.ok === anterior && ultimo.pidiendo === 0 && ultimo.tarjetas > 0) {
      estable += 1;
      if (estable >= 2) {
        return ultimo;
      }
    } else {
      estable = 0;
    }
    anterior = ultimo.ok;
    await dormir(intervaloMs);
  }
  return ultimo;
}
