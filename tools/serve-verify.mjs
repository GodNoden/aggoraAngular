#!/usr/bin/env node
/**
 * Sirve el dashboard compilado y hace de proxy hacia los servicios, en un solo origen.
 *
 * Por que existe: el dev server de Angular (Vite) esta en medio cuando se depura, y para descartarlo
 * hace falta poder servir la app compilada tal cual se publicaria. Esto es tambien, en pequeño, lo
 * que hay que montar el dia del despliegue: la app y el gateway detras del mismo origen.
 *
 * Reparte igual que `proxy.conf.json`:
 *   /api        -> Spring 8089        /ws   -> WebSocket de Spring 8089
 *   /q/api...   -> Quarkus 8189       /q/ws -> WebSocket de Quarkus 8189
 *   /analytics  -> Spring 8085        /actuator -> simulador 8080
 *
 * Uso:
 *   node tools/serve-verify.mjs [puerto]        # por defecto 4300
 *
 * Sin dependencias: `node:http` para servir y proxyar, y un `net` para el upgrade del WebSocket.
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PUERTO = Number(process.argv[2] ?? 4300);
const RAIZ = join(process.cwd(), 'dist/aggora-dashboard/browser');

/** A donde va cada prefijo. El orden importa: /q/api antes que /api. */
const RUTAS = [
  { prefijo: '/q/ws', destino: { host: 'localhost', port: 8189 }, ws: true, quitar: '/q' },
  { prefijo: '/q', destino: { host: 'localhost', port: 8189 }, quitar: '/q' },
  { prefijo: '/ws', destino: { host: 'localhost', port: 8089 }, ws: true },
  { prefijo: '/api', destino: { host: 'localhost', port: 8089 } },
  { prefijo: '/analytics', destino: { host: 'localhost', port: 8085 } },
  { prefijo: '/actuator', destino: { host: 'localhost', port: 8080 } },
];

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function rutaDe(url) {
  return RUTAS.find((ruta) => url === ruta.prefijo || url.startsWith(`${ruta.prefijo}/`) || url.startsWith(`${ruta.prefijo}?`));
}

/** Reenvia una peticion HTTP normal. */
function proxyHttp(peticion, respuesta, ruta) {
  const destino = ruta.quitar ? peticion.url.replace(ruta.quitar, '') : peticion.url;
  const salida = httpRequest(
    {
      host: ruta.destino.host,
      port: ruta.destino.port,
      path: destino,
      method: peticion.method,
      headers: { ...peticion.headers, host: `${ruta.destino.host}:${ruta.destino.port}`, connection: 'close' },
      /*
       * `agent: false`: una conexion nueva por peticion, sin keep-alive.
       *
       * Sin esto el fallo es intermitente y desconcentrante: el proxy guarda un socket ocioso hacia el
       * backend, el backend lo cierra por inactividad, el proxy lo reutiliza igual y la peticion se
       * pierde sin respuesta. Una ejecucion funciona y la siguiente se queda en `loading` para
       * siempre. Conexion nueva cuesta poco y quita el problema de raiz.
       */
      agent: false,
    },
    (aguasArriba) => {
      respuesta.writeHead(aguasArriba.statusCode ?? 502, aguasArriba.headers);
      aguasArriba.pipe(respuesta);
    },
  );
  salida.on('error', (error) => {
    console.error(`[bridge] ${peticion.url} -> ${ruta.destino.port}: ${error.message}`);
    respuesta.writeHead(502, { 'content-type': 'application/json' });
    respuesta.end(JSON.stringify({ error: 'el servicio no responde', detalle: String(error.message) }));
  });
  peticion.pipe(salida);
}

/** Sirve el fichero compilado, con `index.html` como respaldo (la app es una sola pagina). */
async function servirEstatico(peticion, respuesta) {
  const url = (peticion.url ?? '/').split('?')[0];
  const relativa = url === '/' ? 'index.html' : normalize(url).replace(/^(\.\.[/\\])+/, '');
  let ruta = join(RAIZ, relativa);
  try {
    const info = await stat(ruta);
    if (info.isDirectory()) {
      ruta = join(ruta, 'index.html');
    }
  } catch {
    ruta = join(RAIZ, 'index.html');
  }
  try {
    const contenido = await readFile(ruta);
    respuesta.writeHead(200, { 'content-type': TIPOS[extname(ruta)] ?? 'application/octet-stream' });
    respuesta.end(contenido);
  } catch (error) {
    respuesta.writeHead(404, { 'content-type': 'text/plain' });
    respuesta.end(`no encontrado: ${String(error)}`);
  }
}

const servidor = createServer((peticion, respuesta) => {
  const ruta = rutaDe(peticion.url ?? '/');
  if (ruta && !ruta.ws) {
    proxyHttp(peticion, respuesta, ruta);
    return;
  }
  void servirEstatico(peticion, respuesta);
});

/** El upgrade del WebSocket se tunela tal cual: no se entiende el protocolo, solo se reenvia. */
servidor.on('upgrade', (peticion, socket, cabeza) => {
  const ruta = rutaDe(peticion.url ?? '/');
  if (!ruta || !ruta.ws) {
    socket.destroy();
    return;
  }
  const destino = ruta.quitar ? peticion.url.replace(ruta.quitar, '') : peticion.url;
  const aguasArriba = connect(ruta.destino.port, ruta.destino.host, () => {
    const lineas = [`${peticion.method} ${destino} HTTP/1.1`];
    for (const [clave, valor] of Object.entries(peticion.headers)) {
      lineas.push(`${clave}: ${Array.isArray(valor) ? valor.join(', ') : valor}`);
    }
    aguasArriba.write(`${lineas.join('\r\n')}\r\n\r\n`);
    if (cabeza?.length) {
      aguasArriba.write(cabeza);
    }
    socket.pipe(aguasArriba).pipe(socket);
  });
  aguasArriba.on('error', (error) => {
    console.error(`[bridge] ws ${peticion.url} -> ${ruta.destino.port}: ${error.message}`);
    socket.destroy();
  });
  socket.on('error', () => aguasArriba.destroy());
});

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`[bridge] dashboard compilado en http://localhost:${PUERTO}`);
  console.log(`[bridge] sirviendo ${RAIZ}`);
  for (const ruta of RUTAS) {
    console.log(`[bridge]   ${ruta.prefijo}${ruta.ws ? ' (ws)' : ''} -> ${ruta.destino.host}:${ruta.destino.port}`);
  }
});
