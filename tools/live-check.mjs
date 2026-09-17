#!/usr/bin/env node
/**
 * Comprobacion en vivo: la app, contra el backend de verdad, en un navegador de verdad.
 *
 * Que comprueba, y por que eso: que arranque, que **los paneles traigan datos**, que los paneles
 * vacios se expliquen en vez de rellenarse, que el WebSocket entregue, que las graficas se dibujen y
 * que cada panel traiga su explicacion. Y lo repite **despues de recargar**, porque recargar fue el
 * sintoma que se llevo por delante una version entera de esta pagina.
 *
 * Uso:
 *   node tools/live-check.mjs [url] [--dump=fichero.html]
 *
 * Requiere el backend levantado y la app servida (por defecto http://localhost:4300, con
 * `npm run serve:built`). Sale con codigo != 0 si algo falla.
 */

import { writeFileSync } from 'node:fs';
import { abrirNavegador, dormir, esperarEstable } from './browser.mjs';

const URL_APP = (
  process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:4300'
).replace(/\/+$/, '');
const ARG_VOLCADO = process.argv.find((arg) => arg.startsWith('--dump='));

const comprobaciones = [];
function comprobar(nombre, ok, detalle = '') {
  comprobaciones.push({ nombre, ok: Boolean(ok), detalle });
  console.log(`  [${ok ? 'OK  ' : 'FALLO'}] ${nombre}${detalle ? ` -> ${detalle}` : ''}`);
}

/** Lee del DOM pintado todo lo que se quiere comprobar. */
const EXPRESION = `JSON.stringify({
  errorArranque: !!document.getElementById('boot-errors'),
  texto: document.body.innerText.replace(/\\s+/g, ' '),
  html: document.documentElement.outerHTML.length,
  etapas: document.querySelectorAll('.etapa').length,
  etapasEnRojo: document.querySelectorAll('.etapa[data-tone="roto"]').length,
  tarjetas: document.querySelectorAll('article.card').length,
  conDatos: document.querySelectorAll('[data-estado="ok"]').length,
  vacias: document.querySelectorAll('[data-estado="vacio"]').length,
  errores: document.querySelectorAll('[data-estado="error"]').length,
  pidiendo: document.querySelectorAll('[data-estado="pidiendo"]').length,
  trazos: document.querySelectorAll('polyline.line').length,
  filas: document.querySelectorAll('.filas li').length,
  simbolos: document.querySelectorAll('.simbolo').length,
  alertas: document.querySelectorAll('.alerta').length,
  posiciones: document.querySelectorAll('table tbody tr').length,
  ventanas: document.querySelectorAll('.ventanas tbody tr').length,
  explicaciones: (document.body.innerText.match(/Que estas viendo/g) ?? []).length,
  lecciones: (document.body.innerText.match(/bash scripts\\/leccion-/g) ?? []).length,
  seleccion: ['Spring Boot', 'Quarkus', 'Los dos, en paralelo'].every(function (t) { return document.body.innerText.includes(t); })
})`;

function evaluar(v, etiqueta) {
  console.log(`\nComprobaciones sobre la pagina pintada (${etiqueta}):`);
  comprobar('la app arranca y se presenta', v.texto.includes('Aggora') && v.texto.includes('construido dos veces'));
  comprobar('sin aviso de arranque fallido', !v.errorArranque);
  comprobar('el diagrama del pipeline esta', v.etapas === 5, `${v.etapas} etapas`);
  comprobar('las nueve tarjetas estan', v.tarjetas === 9, `${v.tarjetas} tarjetas`);
  comprobar('los paneles traen datos del backend', v.conDatos >= 5, `${v.conDatos} con datos`);
  comprobar('ninguna tarjeta se queda pidiendo', v.pidiendo === 0, `${v.pidiendo} pidiendo`);
  comprobar('ninguna tarjeta da error', v.errores === 0, `${v.errores} con error`);
  comprobar('el panel vacio se explica, no se rellena', v.vacias >= 1 && v.texto.includes('Este panel esta vacio a proposito'));
  comprobar('las graficas se dibujan (polyline a mano)', v.trazos > 0, `${v.trazos} trazos`);
  comprobar('el WebSocket entrega simbolos', v.simbolos > 0, `${v.simbolos} simbolos`);
  comprobar('llegan alertas y posiciones', v.alertas > 0 && v.posiciones > 0, `${v.alertas} alertas, ${v.posiciones} filas`);
  comprobar('el state store responde con ventanas', v.ventanas > 0, `${v.ventanas} ventanas`);
  comprobar('cada panel explica que se esta viendo', v.explicaciones >= 6, `${v.explicaciones} explicaciones`);
  comprobar('las lecciones traen su comando', v.lecciones >= 3, `${v.lecciones} comandos`);
  comprobar('el selector tiene las tres posiciones', v.seleccion);
}

async function leer(cdp) {
  const resultado = await cdp.send('Runtime.evaluate', { expression: EXPRESION, returnByValue: true });
  return JSON.parse(resultado.result.value);
}

const navegador = await abrirNavegador();
console.log(`Comprobando la app en ${URL_APP} con ${navegador.navegador}`);

try {
  // Sesion fresca.
  await navegador.cdp.send('Page.navigate', { url: URL_APP });
  await esperarEstable(navegador.cdp);
  const fresca = await leer(navegador.cdp);
  evaluar(fresca, 'sesion fresca');

  if (ARG_VOLCADO) {
    const resultado = await navegador.cdp.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    writeFileSync(ARG_VOLCADO.split('=')[1], resultado.result.value);
  }

  // La recarga: el sintoma historico. Tiene que comportarse igual que una sesion fresca.
  console.log('\n--- recargando la misma pestana ---');
  await navegador.cdp.send('Page.reload', { ignoreCache: false });
  await dormir(1500);
  await esperarEstable(navegador.cdp);
  const recargada = await leer(navegador.cdp);
  evaluar(recargada, 'despues de recargar');
  comprobar(
    'la recarga trae los mismos paneles con datos',
    recargada.conDatos >= fresca.conDatos - 1,
    `${fresca.conDatos} antes, ${recargada.conDatos} despues`,
  );
} finally {
  navegador.cerrar();
}

const fallos = comprobaciones.filter((c) => !c.ok);
console.log(`\n${comprobaciones.length - fallos.length}/${comprobaciones.length} comprobaciones en verde`);
if (fallos.length > 0) {
  for (const fallo of fallos) {
    console.log(`  - ${fallo.nombre}${fallo.detalle ? ` (${fallo.detalle})` : ''}`);
  }
  process.exit(1);
}
console.log('Comprobacion en verde.');
process.exit(0);
