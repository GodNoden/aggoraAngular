#!/usr/bin/env node
/**
 * Comprobacion en vivo del dashboard desde WSL.
 *
 * Que hace: abre la app en el Chrome de Windows con `--dump-dom`, lee el DOM ya pintado y comprueba
 * que la pagina vive contra el backend de verdad (WebSocket con snapshots, catalogo con series,
 * selector de stacks, modo leccion y paneles vacios que no se rellenan).
 *
 * Dos niveles, porque en este equipo el navegador esta al otro lado de WSL:
 *
 *   1. **render** (por defecto, este script): evidencia en el DOM. No necesita controlar el
 *      navegador, solo leer lo que pinto. Repite el volcado hasta que la pagina esta "caliente"
 *      (llegan mensajes del WebSocket y el catalogo responde).
 *   2. **verify** (`tools/live-check.ps1`, se lanza desde Windows): el informe completo de la propia
 *      pagina en `?verify=1`, con el detalle de cada comprobacion. El puerto de depuracion de Chrome
 *      escucha en Windows y WSL no lo alcanza (el reenvio de localhost de WSL2 va en un solo
 *      sentido), asi que ese nivel tiene que correr del lado de Windows. Ver el README.
 *
 * Uso:
 *   node tools/live-check.mjs [url] [--dump=fichero.html]
 *
 * Requiere el backend levantado y `ng serve` en la url (por defecto http://localhost:4200).
 * Sale con codigo != 0 si alguna comprobacion falla.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_BASE = (
  process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:4200'
).replace(/\/+$/, '');
const URL_APP = `${URL_BASE}/?verify=1`;
const ARG_VOLCADO = process.argv.find((arg) => arg.startsWith('--dump='));
const INTENTOS = Number(process.env.LIVE_INTENTOS ?? 6);

const CANDIDATOS = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const chrome = CANDIDATOS.find((ruta) => {
  try {
    return existsSync(ruta);
  } catch {
    return false;
  }
});

if (!chrome) {
  console.error('No encontre Chrome. Exporta CHROME_BIN apuntando a tu binario.');
  process.exit(2);
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Volcado del DOM: Chrome abre la pagina, la deja vivir y escribe el HTML por stdout. */
function volcarDom() {
  const perfilLinux = mkdtempSync(join(tmpdir(), 'aggora-live-'));
  const perfil = chrome.endsWith('.exe')
    ? execSync(`wslpath -w ${JSON.stringify(perfilLinux)}`).toString().trim()
    : perfilLinux;
  const argumentos = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    `--user-data-dir=${perfil}`,
    // Sin tope de tiempo virtual: con `--virtual-time-budget` Chrome no cierra la pestaña (el
    // dashboard tiene un WebSocket y un reloj vivos) y el volcado nunca sale.
    '--timeout=20000',
    '--dump-dom',
    URL_APP,
  ];
  return new Promise((resolve) => {
    const hijo = spawn(chrome, argumentos, { stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (dato) => {
      salida += String(dato);
    });
    hijo.on('error', () => resolve(''));
    hijo.on('exit', () => resolve(salida));
    setTimeout(() => {
      try {
        hijo.kill('SIGKILL');
      } catch {
        // Ya estaba muerto.
      }
      resolve(salida);
    }, 60000);
  });
}

const aTexto = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const comprobaciones = [];
function comprobar(nombre, ok, detalle = '') {
  comprobaciones.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  [${ok ? 'OK  ' : 'KO  '}] ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}

/** La pagina esta "caliente" cuando ya llego algo del WebSocket o del catalogo. */
function caliente(html, texto) {
  const mensajes = Number(/\((\d+) messages parsed\)/.exec(texto)?.[1] ?? /(\d+) messages parsed/.exec(texto)?.[1] ?? 0);
  const cargando = (texto.match(/\bloading\b/g) ?? []).length;
  return mensajes > 3 || cargando === 0;
}

console.log(`Comprobando la app en ${URL_APP}`);
console.log(`  chrome: ${chrome}`);

let html = '';
let texto = '';
for (let intento = 1; intento <= INTENTOS; intento += 1) {
  html = await volcarDom();
  texto = aTexto(html);
  const ok = html.length > 5000 && texto.length > 3000 && caliente(html, texto);
  console.log(`  volcado ${intento}/${INTENTOS}: dom=${html.length} B, texto=${texto.length} B${ok ? ' (caliente)' : ''}`);
  if (ok) {
    break;
  }
  await dormir(2000);
}

if (ARG_VOLCADO) {
  writeFileSync(ARG_VOLCADO.split('=')[1], html);
}

console.log('\nComprobaciones sobre el DOM pintado:');

comprobar('la app arranca y pinta la cabecera', texto.includes('Aggora') && texto.includes('Lesson mode'), `texto visible=${texto.length} B`);
comprobar(
  'la barra de arranque no reporta fallos (sin pantalla negra)',
  !html.includes('id="boot-errors"'),
  html.includes('id="boot-errors"') ? 'hay un bloque #boot-errors' : 'sin errores de arranque',
);

const mensajes = Number(/(\d+) messages parsed/.exec(texto)?.[1] ?? 0);
comprobar('el WebSocket ha entregado mensajes y se cuentan', mensajes > 3, `${mensajes} mensajes parseados`);

const socketVivo = /Spring: live/.test(texto);
comprobar('el socket aparece como live (no "connecting")', socketVivo, /Spring: [^·]*/.exec(texto)?.[0]?.trim() ?? '');

const snapshots = Number(/Snapshot every second\. (\d+) received/.exec(texto)?.[1] ?? 0);
comprobar('llegan snapshots (uno por segundo)', snapshots > 0, `${snapshots} snapshots recibidos`);

const simbolos = Number(/Last tick per symbol \((\d+)\)/.exec(texto)?.[1] ?? 0);
comprobar('la ultima foto trae simbolos', simbolos > 0, `${simbolos} simbolos`);

const crudo = /(\d[\d,]*)\s*ticks\/s in/.exec(texto)?.[1] ?? '';
comprobar('la tasa de ticks de entrada se pinta con un numero', crudo !== '' && crudo !== '--', `${crudo} ticks/s`);

const alertas = Number(/Alerts \((\d+)\)/.exec(texto)?.[1] ?? 0);
const posiciones = Number(/Positions \((\d+)\)/.exec(texto)?.[1] ?? 0);
comprobar('las alertas y las posiciones llegan al momento', alertas > 0 && posiciones > 0, `${alertas} alertas, ${posiciones} posiciones`);

const trazos = (html.match(/class="line"/g) ?? []).length;
comprobar('las graficas se dibujan en SVG (a mano, sin libreria)', trazos > 0, `${trazos} trazos SVG`);

const cargando = (texto.match(/\bloading\b/g) ?? []).length;
comprobar('el catalogo de metricas responde (los paneles estan en "ok")', cargando === 0, `${cargando} paneles aun en loading`);

const gruposLag = /Consumer lag/.test(texto) && /ingestion-normalizer/.test(texto);
comprobar('el lag lista los grupos de consumidores del contrato', gruposLag, 'ingestion-normalizer presente');

const panelVacio = texto.includes('This panel is empty on purpose');
comprobar('el panel de transacciones explica el hueco en vez de inventar', panelVacio, panelVacio ? 'nota presente' : 'sin nota');

const lecciones = (texto.match(/bash scripts\/leccion-\d-/g) ?? []).length;
comprobar('el modo leccion trae los comandos de las cinco lecciones', lecciones >= 5, `${lecciones} comandos`);

const selector = ['Spring', 'Quarkus', 'Spring + Quarkus'].every((etiqueta) => texto.includes(etiqueta));
comprobar('el selector de stack tiene sus tres posiciones', selector, 'Spring / Quarkus / Spring + Quarkus');

const comparativa = texto.includes('comparativa&de=') || texto.includes('Side by side');
comprobar('el modo lado a lado esta en la pagina', comparativa, '');

const fallos = comprobaciones.filter((c) => !c.ok);
console.log(`\n${comprobaciones.length - fallos.length}/${comprobaciones.length} comprobaciones en verde`);
if (fallos.length > 0) {
  console.log('Fallos:');
  for (const fallo of fallos) {
    console.log(`  - ${fallo.nombre}${fallo.detalle ? ` (${fallo.detalle})` : ''}`);
  }
  if (ARG_VOLCADO) {
    console.log(`DOM volcado en ${ARG_VOLCADO.split('=')[1]} para inspeccionar`);
  }
  process.exit(1);
}
console.log('Comprobacion en verde.');
process.exit(0);
