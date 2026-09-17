#!/usr/bin/env node
/**
 * Ejecuta los tests y decide el resultado por lo que dicen los tests, no por el cierre del navegador.
 *
 * Por que existe: en este equipo el navegador corre en Windows y WSL lanza su .exe. Al terminar, el
 * navegador tarda en cerrar y se desconecta del servidor de Karma, que ya esta apagandose; Karma
 * entonces sale con codigo 1 **aunque todo este en verde**. Eso rompe cualquier script que dependa
 * del codigo de salida (CI, un pre-push, `npm test`).
 *
 * Ademas, Karma acumula los recuentos de cada conexion de navegador, asi que su `TOTAL:` puede sumar
 * varias pasadas. Aqui se toma el tamano real de la suite (el "de N" mayor) y se comprueba que
 * ninguna pasada termino con fallos.
 *
 * Codigos de salida: 0 todo verde, 1 algun fallo, 2 el navegador no llego a ejecutar los tests.
 */

import { execFileSync, spawnSync } from 'node:child_process';

// Limpieza previa: un navegador zombi de una ejecucion cortada bloquea el perfil temporal y la
// siguiente ejecucion falla con "Cannot start ChromeHeadless".
spawnSync(process.execPath, ['tools/clean-browsers.mjs'], { stdio: 'inherit' });

const comando = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const inicio = Date.now();

let salida = '';
try {
  salida = execFileSync(comando, ['ng', 'test', '--watch=false'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? '/tmp/npm-cache-ang' },
  });
} catch (error) {
  // Karma puede salir != 0 por la desconexion del navegador: el texto es lo que manda.
  salida = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

console.log(salida.trimEnd());

/** Tamano real de la suite: el mayor "of N" que reporto el navegador. */
const tamanoSuite = Math.max(
  0,
  ...[...salida.matchAll(/Executed \d+ of (\d+)/g)].map((coincidencia) => Number(coincidencia[1])),
);

/** Fallos reportados por cualquier via: resumen `TOTAL:` o lineas "Executed ... (N FAILED)". */
const fallos = Math.max(
  0,
  ...[...salida.matchAll(/TOTAL:\s*(\d+) FAILED/g)].map((c) => Number(c[1])),
  ...[...salida.matchAll(/Executed \d+ of \d+ \((\d+) FAILED\)/g)].map((c) => Number(c[1])),
);

if (tamanoSuite === 0) {
  console.error('\n[test] el navegador no llego a ejecutar los tests (no hay resumen)');
  process.exit(2);
}

const exitos = Math.max(0, tamanoSuite - fallos);
const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

console.log(`\n[test] ${exitos} en verde, ${fallos} en rojo (${segundos} s)`);
process.exit(fallos > 0 ? 1 : 0);
