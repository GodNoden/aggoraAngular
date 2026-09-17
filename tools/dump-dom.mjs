#!/usr/bin/env node
/**
 * Lanza el navegador de Windows (Edge/Chrome) desde WSL y devuelve el DOM pintado por stdout.
 *
 * Por que existe: en este equipo no hay navegador dentro de WSL y el de Windows no entiende una
 * ruta Linux de `--user-data-dir`; sin traducirla, el navegador arranca y muere con codigo 21.
 * `tools/chrome-wsl.sh` ya resuelve eso para Karma; esto es lo mismo pero de un uso: volcar el DOM.
 *
 * **Aviso, y es importante:** `--dump-dom` devuelve la pagina cuando el navegador cree que ya cargo,
 * que en esta app es **antes** de que los paneles traigan datos (se piden de uno en uno). Para
 * comprobar que la pagina funciona usa `npm run verify:live`; para ver consola y red, usa
 * `npm run diag:browser`. Esto solo vale para mirar el HTML inicial (que los estilos y el esqueleto
 * salen, por ejemplo), y por eso lo dice al terminar.
 *
 * Uso:
 *   node tools/dump-dom.mjs <url> [msDeVida]
 *
 * `msDeVida` es cuanto se deja vivir la pagina antes de forzar el cierre (por defecto 20000 ms).
 * Sin un cierre forzado el volcado no termina nunca: el dashboard tiene un WebSocket y un reloj
 * vivos, y `--dump-dom` espera a que la pagina se quede quieta.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.argv[2];
const VIDA_MS = Number(process.argv[3] ?? 20000);

if (!URL) {
  console.error('uso: node tools/dump-dom.mjs <url> [msDeVida]');
  process.exit(2);
}

const CANDIDATOS = [
  process.env.CHROME_BIN,
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const navegador = CANDIDATOS.find((ruta) => {
  try {
    return existsSync(ruta);
  } catch {
    return false;
  }
});

if (!navegador) {
  console.error('no encontre navegador; exporta CHROME_BIN');
  process.exit(2);
}

const esWindows = navegador.endsWith('.exe');
const perfilLinux = mkdtempSync(join(tmpdir(), 'aggora-dump-'));
const perfil = esWindows
  ? execSync(`wslpath -w ${JSON.stringify(perfilLinux)}`).toString().trim()
  : perfilLinux;

const argumentos = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  `--user-data-dir=${perfil}`,
  /*
   * Sin `--virtual-time-budget` el volcado sale en cuanto el HTML esta parseado y los `setTimeout` de
   * la pagina no llegan a correr: se ve el esqueleto, no lo que pinto el JavaScript. Con presupuesto
   * virtual, el navegador adelanta los temporizadores y vuelca al agotarlo.
   */
  `--virtual-time-budget=${VIDA_MS}`,
  '--dump-dom',
  URL,
];

const hijo = spawn(navegador, argumentos, { stdio: ['ignore', 'pipe', 'ignore'] });
let salida = '';
hijo.stdout.on('data', (dato) => {
  salida += String(dato);
});

const remate = setTimeout(() => {
  try {
    hijo.kill('SIGKILL');
  } catch {
    // ya estaba muerto
  }
}, VIDA_MS + 15000);

hijo.on('exit', () => {
  clearTimeout(remate);
  process.stdout.write(salida);
  process.stderr.write(
    '\n[dump-dom] aviso: este volcado sale antes de que los paneles traigan datos. ' +
      'Para comprobar la pagina: npm run verify:live. Para consola y red: npm run diag:browser.\n',
  );
});
hijo.on('error', (error) => {
  clearTimeout(remate);
  console.error('no se pudo lanzar el navegador: ' + error.message);
  process.exit(2);
});
