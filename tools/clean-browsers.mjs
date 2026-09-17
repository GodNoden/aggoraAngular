#!/usr/bin/env node
/**
 * Limpia navegadores headless que quedaron zombis de una ejecucion anterior.
 *
 * Por que hace falta: Karma lanza el navegador con un perfil temporal y, si una ejecucion se corta a
 * medias (Ctrl+C, un timeout, un test que se cuelga), el proceso queda vivo y bloquea el perfil. La
 * siguiente ejecucion entonces falla con "Cannot start ChromeHeadless", que no dice nada util.
 *
 * **Solo mata navegadores headless con perfil de test** (`--user-data-dir` con karma- o aggora-), asi
 * que no toca las ventanas que el usuario tenga abiertas. Esa parte importa: matar el navegador de
 * alguien para poder correr tests es peor que el problema.
 */

import { execSync } from 'node:child_process';

const PATRONES = [/--headless/, /(karma-|aggora-)[^/\\]*$/];

/** Navegadores de test actuales, segun `ps`. */
function procesosDeTest() {
  let salida = '';
  try {
    salida = execSync('ps -eo pid,args', { encoding: 'utf8' });
  } catch {
    return [];
  }
  return salida
    .split('\n')
    .slice(1)
    .map((linea) => {
      const coincidencia = /^\s*(\d+)\s+(.*)$/.exec(linea);
      return coincidencia ? { pid: Number(coincidencia[1]), args: coincidencia[2] } : null;
    })
    .filter((proceso) => proceso !== null);
}

const candidatos = procesosDeTest().filter((proceso) => {
  const esNavegador = /(chrome|msedge|chromium)(\.exe)?/i.test(proceso.args);
  const esHeadless = PATRONES[0].test(proceso.args);
  const esDeTest = PATRONES[1].test(proceso.args) || /karma-|aggora-live-|aggora-dump-/.test(proceso.args);
  return esNavegador && esHeadless && esDeTest;
});

if (candidatos.length === 0) {
  console.log('[clean-browsers] no hay navegadores de test zombis');
  process.exit(0);
}

console.log(`[clean-browsers] matando ${candidatos.length} navegador(es) de test zombi(s)`);
for (const proceso of candidatos) {
  try {
    process.kill(proceso.pid, 'SIGKILL');
    console.log(`[clean-browsers]   pid ${proceso.pid}`);
  } catch {
    // Ya estaba muerto.
  }
}
