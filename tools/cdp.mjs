#!/usr/bin/env node
/**
 * Cliente minimo del protocolo de depuracion de Chrome (CDP), sin dependencias.
 *
 * Hace falta porque la evidencia que pide el HANDOFF ("mira la pestana Network y la consola") no se
 * puede obtener desde WSL con `--dump-dom`: ese volcado sale antes de que la app termine de pedir
 * nada. Con CDP se controla el navegador de verdad: se escucha la consola, se ven las peticiones y
 * sus respuestas, y se puede recargar la pagina a voluntad.
 *
 * Solo implementa lo que hace falta: el `upgrade` del WebSocket, frames de texto, ping/pong y cierre.
 */

import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

/** Se conecta al endpoint de CDP de una pestana y devuelve un cliente con `send` y eventos. */
export function conectarCdp(wsUrl, { onEvent = () => {}, onClose = () => {} } = {}) {
  const url = new URL(wsUrl);
  const clave = randomBytes(16).toString('base64');
  const socket = connect(Number(url.port), url.hostname);

  let buffer = Buffer.alloc(0);
  let abierto = false;
  const pendientes = new Map();
  const oyentes = [];
  let siguienteId = 1;

  const espera = new Promise((resolver, rechazar) => {
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${clave}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('error', rechazar);
    socket.on('data', (trozo) => {
      buffer = Buffer.concat([buffer, trozo]);
      if (!abierto) {
        const fin = buffer.indexOf('\r\n\r\n');
        if (fin === -1) return;
        const cabecera = buffer.subarray(0, fin).toString('latin1');
        buffer = buffer.subarray(fin + 4);
        const esperado = createHash('sha1')
          .update(`${clave}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (!cabecera.includes(esperado)) {
          rechazar(new Error(`el upgrade no cuadra: ${cabecera.split('\r\n')[0]}`));
          return;
        }
        abierto = true;
        resolver(api);
      }
      for (const mensaje of extraerFrames(() => buffer, (nuevo) => (buffer = nuevo))) {
        try {
          if (mensaje.tipo === 'texto') {
            let evento;
            try {
              evento = JSON.parse(mensaje.datos);
            } catch {
              continue;
            }
            if (evento.id && pendientes.has(evento.id)) {
              const { resolver, rechazar } = pendientes.get(evento.id);
              pendientes.delete(evento.id);
              if (evento.error) rechazar(new Error(JSON.stringify(evento.error)));
              else resolver(evento.result ?? {});
            } else {
              onEvent(evento);
              for (const oyente of oyentes) oyente(evento);
            }
          } else if (mensaje.tipo === 'ping') {
            enviarFrame(socket, 0x9, mensaje.datos);
          } else if (mensaje.tipo === 'close') {
            socket.end();
          }
        } catch (error) {
          // Un oyente que falla no puede tumbar el cliente de depuracion: se apunta y se sigue.
          console.error('[cdp] un oyente fallo:', error);
        }
      }
    });
    socket.on('close', () => {
      abierto = false;
      onClose();
      for (const { rechazar } of pendientes.values()) rechazar(new Error('la conexion CDP se cerro'));
      pendientes.clear();
    });
  });

  const api = {
    /** Envia un comando CDP y espera su resultado. */
    send(metodo, params = {}) {
      const id = siguienteId++;
      const carga = Buffer.from(JSON.stringify({ id, method: metodo, params }));
      return new Promise((resolver, rechazar) => {
        pendientes.set(id, { resolver, rechazar });
        enviarFrame(socket, 0x1, carga);
        setTimeout(() => {
          if (pendientes.has(id)) {
            pendientes.delete(id);
            rechazar(new Error(`CDP sin respuesta a ${metodo} en 15 s`));
          }
        }, 15000).unref();
      });
    },
    /** Se suscribe a los eventos que lleguen. */
    on(fn) {
      oyentes.push(fn);
    },
    cerrar() {
      try {
        enviarFrame(socket, 0x8, Buffer.alloc(0));
      } catch {
        /* da igual */
      }
      socket.end();
    },
    get listo() {
      return abierto;
    },
    espera,
  };

  return api;
}

/** Escribe un frame del cliente (siempre enmascarado, como manda el RFC). */
function enviarFrame(socket, opcode, carga) {
  const mascara = randomBytes(4);
  const longitud = carga.length;
  const cabecera = [];
  cabecera.push(0x80 | opcode);
  if (longitud < 126) {
    cabecera.push(0x80 | longitud);
  } else if (longitud < 65536) {
    cabecera.push(0x80 | 126, (longitud >> 8) & 0xff, longitud & 0xff);
  } else {
    cabecera.push(0x80 | 127, 0, 0, 0, 0, (longitud >>> 24) & 0xff, (longitud >>> 16) & 0xff, (longitud >>> 8) & 0xff, longitud & 0xff);
  }
  const cuerpo = Buffer.from(carga);
  for (let i = 0; i < cuerpo.length; i += 1) {
    cuerpo[i] ^= mascara[i % 4];
  }
  socket.write(Buffer.concat([Buffer.from(cabecera), mascara, cuerpo]));
}

/**
 * Saca los frames completos del buffer.
 *
 * Un frame puede llegar partido entre dos paquetes TCP (y los snapshots del dashboard son grandes),
 * asi que aqui se acumula hasta tener el frame entero antes de interpretarlo.
 */
function extraerFrames(leerBuffer, escribirBuffer) {
  const salida = [];
  let buffer = leerBuffer();
  for (;;) {
    if (buffer.length < 2) break;
    const opcode = buffer[0] & 0x0f;
    const enmascarado = (buffer[1] & 0x80) !== 0;
    let longitud = buffer[1] & 0x7f;
    let offset = 2;
    if (longitud === 126) {
      if (buffer.length < 4) break;
      longitud = buffer.readUInt16BE(2);
      offset = 4;
    } else if (longitud === 127) {
      if (buffer.length < 10) break;
      longitud = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const mascara = enmascarado ? buffer.subarray(offset, offset + 4) : null;
    if (enmascarado) offset += 4;
    if (buffer.length < offset + longitud) break;
    const datos = Buffer.from(buffer.subarray(offset, offset + longitud));
    if (mascara) {
      for (let i = 0; i < datos.length; i += 1) datos[i] ^= mascara[i % 4];
    }
    buffer = buffer.subarray(offset + longitud);
    const tipo = opcode === 0x1 ? 'texto' : opcode === 0x9 ? 'ping' : opcode === 0x8 ? 'close' : opcode === 0xa ? 'pong' : 'otros';
    salida.push({ tipo, datos });
  }
  escribirBuffer(buffer);
  return salida;
}
