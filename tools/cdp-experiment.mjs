#!/usr/bin/env node
/**
 * El experimento que faltaba: mirar la consola y las peticiones del navegador, y **recargar**.
 *
 * El HANDOFF dice que el sintoma no esta resuelto y que lo que nunca se obtuvo fue la respuesta a
 * una pregunta: cuando la pagina se queda en `loading`, la peticion `/api/metrics?panel=pulso` esta
 * `pending` o `200`. Esto la mide, con el navegador de verdad, en dos fases sobre la misma pestana:
 *
 *   1. sesion fresca: navega, espera, lee el estado de la app (informe `?diag=1`) y las peticiones.
 *   2. reload: recarga la MISMA pestana y vuelve a medir.
 *
 * Y hay una segunda pregunta, que salio de la primera ejecucion de esto: si la pagina se queda
 * colgada, ¿es que el renderer esta bloqueado (no atiende ni una orden de depuracion) o solo que la
 * app no procesa las respuestas? Para distinguirlo, cada fase hace varias sondas `Runtime.evaluate`
 * seguidas; si la primera contesta y las siguientes no, el hilo se bloqueo en algun momento medible.
 *
 * Requiere: el bridge (`node tools/serve-verify.mjs 4300`), Edge/Chrome con `--remote-debugging-port`
 * en Windows y el rele (`node tools/tcp-relay.mjs 9223 9222`).
 *
 * Uso:
 *   node tools/cdp-experiment.mjs [urlApp] [puertoCdp] [msPorFase]
 */

import { conectarCdp } from './cdp.mjs';

const URL_APP = process.argv[2] ?? 'http://localhost:4300/?diag=1';
const PUERTO_CDP = Number(process.argv[3] ?? 9223);
const FASE_MS = Number(process.argv[4] ?? 9000);
const MAX_CONSOLA = Number(process.env.MAX_CONSOLA ?? 400);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
function log(linea) {
  console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${linea}`);
}

/** Cambia el puerto del endpoint de CDP por el del rele local. */
function reescribirAlRele(wsUrl) {
  const url = new URL(wsUrl);
  url.hostname = '127.0.0.1';
  url.port = String(PUERTO_CDP);
  return url.toString();
}

/** Crea una pestana nueva con el endpoint HTTP de CDP. */
async function nuevaPestana() {
  const respuesta = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/new?about:blank`, { method: 'PUT' });
  const datos = await respuesta.json();
  return reescribirAlRele(datos.webSocketDebuggerUrl);
}

/**
 * Estado del reloj interno del cliente CDP.
 *
 * Existe porque el sintoma puede ser "el renderer deja de atender": si las respuestas del protocolo
 * dejan de llegar, hay que saberlo por el diario y no por un timeout mudo.
 */
const salud = { respuestasCdp: 0, ultimaRespuesta: null };

async function principal() {
  log(`pestana nueva en el puerto ${PUERTO_CDP}`);
  const wsUrl = await nuevaPestana();
  log(`endpoint: ${wsUrl}`);

  const consola = [];
  const peticiones = new Map();
  const respuestas = [];
  const excepciones = [];
  const fallosRed = [];
  let wsEventos = 0;

  const cdp = conectarCdp(wsUrl);
  cdp.on((evento) => {
    if (evento.id) {
      return;
    }
    switch (evento.method) {
      case 'Runtime.consoleAPICalled': {
        const texto = (evento.params.args ?? [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
          .join(' ');
        consola.push(texto);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = evento.params.exceptionDetails;
        excepciones.push(d.exception?.description ?? d.text);
        break;
      }
      case 'Log.entryAdded': {
        if (evento.params.entry.level === 'error') {
          excepciones.push(`log: ${evento.params.entry.text}`);
        }
        break;
      }
      case 'Network.requestWillBeSent': {
        peticiones.set(evento.params.requestId, {
          url: evento.params.request.url,
          metodo: evento.params.request.method,
          inicio: Date.now() - t0,
          tipo: evento.params.type,
        });
        break;
      }
      case 'Network.responseReceived': {
        respuestas.push({
          url: evento.params.response.url,
          status: evento.params.response.status,
          ms: Date.now() - t0,
          tipo: evento.params.type,
        });
        break;
      }
      case 'Network.loadingFailed': {
        const peticion = peticiones.get(evento.params.requestId);
        fallosRed.push({
          url: peticion?.url ?? '?',
          error: evento.params.errorText,
          cancelado: evento.params.canceled ?? false,
          ms: Date.now() - t0,
        });
        break;
      }
      case 'Network.webSocketCreated':
        wsEventos += 1;
        log(`  ws creado: ${evento.params.url}`);
        break;
      case 'Network.webSocketHandshakeResponseReceived':
        log(`  ws handshake: HTTP ${evento.params.response.status} en ${evento.params.response.headers?.['Sec-WebSocket-Accept'] ? 'con accept' : 'sin accept'}`);
        break;
      case 'Network.webSocketClosed':
        log('  ws cerrado');
        break;
      case 'Network.webSocketFrameReceived':
      case 'Network.webSocketFrameSent':
        break;
      default:
        break;
    }
  });

  await cdp.espera;
  // Un solo mensaje de confirmacion: demasiados comandos de golpe saturan al rele.
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  log('dominios habilitados (Runtime, Log, Network, Page)');

  /** Una sonda: si el renderer atiende, contesta; si no, se agota el plazo y se apunta. */
  async function sondear(etiqueta) {
    const inicio = Date.now();
    try {
      const resultado = await Promise.race([
        cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({href: location.href, listo: document.readyState, diag: document.getElementById("diag-report")?.textContent ?? null, traza: (globalThis.__aggoraTrace ?? []).length, sonda: (globalThis.__aggoraProbe?.lines ?? []).length})',
          returnByValue: true,
        }),
        dormir(3000).then(() => ({ __agoto: true })),
      ]);
      if (resultado.__agoto) {
        log(`sonda "${etiqueta}": SIN RESPUESTA en 3000 ms (renderer bloqueado o saturado)`);
        return null;
      }
      salud.respuestasCdp += 1;
      salud.ultimaRespuesta = Date.now() - t0;
      const datos = JSON.parse(resultado.result.value);
      log(`sonda "${etiqueta}": respondio en ${Date.now() - inicio} ms`);
      if (datos.diag) {
        log(`  --- informe ---\n${indentar(datos.diag)}`);
      } else {
        log(`  sin #diag-report; traza=${datos.traza} lineas, sonda=${datos.sonda} lineas`);
      }
      return datos;
    } catch (error) {
      log(`sonda "${etiqueta}": fallo (${error.message})`);
      return null;
    }
  }

  function indentar(texto) {
    return texto
      .split('\n')
      .map((linea) => `  | ${linea}`)
      .join('\n');
  }

  /** La app solo pide un panel cada vez (en serie): esta es la cola de peticiones del catalogo. */
  function resumenPeticiones() {
    const catalogo = [...peticiones.values()].filter((p) => p.url.includes('/metrics'));
    const contestadas = catalogo.filter((p) => respuestas.some((r) => r.url === p.url));
    log(`peticiones al catalogo: ${catalogo.length} lanzadas, ${contestadas.length} con respuesta`);
    for (const peticion of catalogo) {
      const respuesta = respuestas.find((r) => r.url === peticion.url);
      log(`  ${respuesta ? respuesta.status : 'SIN RESPUESTA'} ${peticion.url.replace(/^http:\/\/localhost:4300/, '')} (+${peticion.inicio} ms)`);
    }
  }

  // ---------------------------------------------------------------- fase 1: sesion fresca
  log(`FASE 1: navegando a ${URL_APP}`);
  const navegacion = Date.now();
  await cdp.send('Page.navigate', { url: URL_APP });
  log(`  Page.navigate contesto en ${Date.now() - navegacion} ms`);
  for (let i = 1; i <= Math.ceil(FASE_MS / 3000); i += 1) {
    await dormir(3000);
    await sondear(`fresca ${i * 3}s`);
  }
  const consolaFase1 = consola.length;
  resumenPeticiones();

  // ---------------------------------------------------------------- fase 2: recarga
  log('FASE 2: RECARGANDO la misma pestana');
  const recarga = Date.now();
  try {
    await cdp.send('Page.reload', { ignoreCache: false });
    log(`  Page.reload contesto en ${Date.now() - recarga} ms`);
  } catch (error) {
    log(`  Page.reload fallo: ${error.message}`);
  }
  for (let i = 1; i <= Math.ceil(FASE_MS / 3000); i += 1) {
    await dormir(3000);
    await sondear(`reload ${i * 3}s`);
  }
  resumenPeticiones();

  // ---------------------------------------------------------------- resumen
  log(`--- consola de la app (${consola.length} lineas; mostrando trazas de la app) ---`);
  const relevantes = consola.filter((linea) => linea.includes('[aggora]'));
  for (const linea of relevantes.slice(-MAX_CONSOLA)) log(`  ${linea.slice(0, 220)}`);

  log('--- respuestas HTTP ---');
  for (const respuesta of respuestas) {
    log(`  ${respuesta.status} ${respuesta.url.replace(/^http:\/\/localhost:4300/, '')} (a los ${respuesta.ms} ms)`);
  }
  log('--- fallos de red ---');
  for (const fallo of fallosRed) {
    log(`  ${fallo.error}${fallo.cancelado ? ' (cancelado)' : ''} ${fallo.url.replace(/^http:\/\/localhost:4300/, '')}`);
  }
  log('--- excepciones ---');
  for (const excepcion of excepciones.slice(0, 20)) log(`  ${excepcion.slice(0, 300)}`);

  log(`RESUMEN: ${respuestas.length} respuestas, ${peticiones.size} peticiones, ${fallosRed.length} fallos de red, ${excepciones.length} excepciones, ${wsEventos} eventos de WebSocket, ${salud.respuestasCdp} sondas contestadas`);

  cdp.cerrar();
  process.exit(0);
}

principal().catch((error) => {
  console.error('[experimento] fallo:', error);
  process.exit(1);
});
