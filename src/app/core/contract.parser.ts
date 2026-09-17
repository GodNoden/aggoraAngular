/**
 * Parseo del contrato: del JSON crudo a los tipos de `contract.ts`.
 *
 * Principios, y son deliberados:
 *
 *  1. **Nunca lanza.** Un frame raro del WebSocket no puede tumbar la pagina; devuelve un fallo
 *     explicado y la app sigue. El WebSocket es un fan-out: el siguiente snapshot arregla el hueco.
 *  2. **Estricto en lo que importa, tolerante en lo accesorio.** Si falta `ticksIn` el snapshot no
 *     sirve: se rechaza. Si el backend anade un campo nuevo, se ignora sin ruido (los tipos avisan
 *     al que los mantiene, no al que los lee).
 *  3. **Los errores dicen que campo fallo.** Un `valor de ticksIn no es un numero` ahorra media hora.
 */

import {
  AlertMessage,
  Envelope,
  LiveMessage,
  MetricPoint,
  MetricSeries,
  MetricsResponse,
  ParseResult,
  PositionMessage,
  SEVERITIES,
  Severity,
  SnapshotMessage,
  Stack,
  SymbolTick,
} from './contract';

/* ------------------------------------------------------------------------------------------- */
/* Utilidades de validacion                                                                      */
/* ------------------------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

class ContractError extends Error {}

function objeto(valor: unknown, campo: string): Json {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    throw new ContractError(`"${campo}" no es un objeto`);
  }
  return valor as Json;
}

function texto(valor: unknown, campo: string): string {
  if (typeof valor !== 'string') {
    throw new ContractError(`"${campo}" no es texto (llego ${tipoDe(valor)})`);
  }
  return valor;
}

function numero(valor: unknown, campo: string): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    throw new ContractError(`"${campo}" no es un numero (llego ${tipoDe(valor)})`);
  }
  return valor;
}

function booleano(valor: unknown, campo: string): boolean {
  if (typeof valor !== 'boolean') {
    throw new ContractError(`"${campo}" no es un booleano (llego ${tipoDe(valor)})`);
  }
  return valor;
}

function tipoDe(valor: unknown): string {
  if (valor === null) {
    return 'null';
  }
  if (Array.isArray(valor)) {
    return 'array';
  }
  return typeof valor;
}

/** El stack llega como `spring` o `quarkus`; se normaliza por si algun dia llega con mayusculas. */
function stack(valor: unknown, campo: string): Stack {
  const bruto = texto(valor, campo).toLowerCase();
  if (bruto !== 'spring' && bruto !== 'quarkus') {
    throw new ContractError(`"${campo}" no es un stack conocido (llego "${bruto}")`);
  }
  return bruto;
}

/** El envoltorio comun a los tres mensajes. */
function envoltorio(datos: Json): Envelope {
  return {
    v: numero(datos['v'], 'v'),
    kind: texto(datos['kind'], 'kind'),
    stack: stack(datos['stack'], 'stack'),
    ts: texto(datos['ts'], 'ts'),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Mensajes del WebSocket                                                                        */
/* ------------------------------------------------------------------------------------------- */

function parseSymbolTick(valor: unknown, campo: string): SymbolTick {
  const datos = objeto(valor, campo);
  return {
    price: texto(datos['price'], `${campo}.price`),
    currency: texto(datos['currency'], `${campo}.currency`),
    size: numero(datos['size'], `${campo}.size`),
    source: texto(datos['source'], `${campo}.source`),
    at: texto(datos['at'], `${campo}.at`),
  };
}

function parseSnapshot(datos: Json, sobre: Envelope): SnapshotMessage {
  const bruto = objeto(datos['symbols'], 'symbols');
  const symbols: Record<string, SymbolTick> = {};
  for (const [simbolo, tick] of Object.entries(bruto)) {
    symbols[simbolo] = parseSymbolTick(tick, `symbols.${simbolo}`);
  }
  return {
    ...sobre,
    kind: 'snapshot',
    ticksIn: numero(datos['ticksIn'], 'ticksIn'),
    ticksOut: numero(datos['ticksOut'], 'ticksOut'),
    symbols,
  };
}

function parsePosition(datos: Json, sobre: Envelope): PositionMessage {
  return {
    ...sobre,
    kind: 'position',
    account: texto(datos['account'], 'account'),
    symbol: texto(datos['symbol'], 'symbol'),
    quantity: numero(datos['quantity'], 'quantity'),
    averageCost: texto(datos['averageCost'], 'averageCost'),
    realizedPnl: texto(datos['realizedPnl'], 'realizedPnl'),
    exposure: texto(datos['exposure'], 'exposure'),
    currency: texto(datos['currency'], 'currency'),
    marginBreach: booleano(datos['marginBreach'], 'marginBreach'),
  };
}

function parseAlert(datos: Json, sobre: Envelope): AlertMessage {
  const bruta = texto(datos['severity'], 'severity').toUpperCase();
  // Si el backend estrena una severidad, se normaliza a INFO en vez de perder la alerta: enterarse
  // de que algo pasa importa mas que la etiqueta.
  const severity: Severity = (SEVERITIES as readonly string[]).includes(bruta)
    ? (bruta as Severity)
    : 'INFO';
  return {
    ...sobre,
    kind: 'alert',
    severity,
    type: texto(datos['type'], 'type'),
    subject: texto(datos['subject'], 'subject'),
    detail: texto(datos['detail'], 'detail'),
    value: texto(datos['value'], 'value'),
    raisedAt: texto(datos['raisedAt'], 'raisedAt'),
  };
}

/**
 * Parsea un frame del WebSocket. Nunca lanza.
 *
 * @param crudo el texto tal cual llego por el socket.
 */
export function parseLiveMessage(crudo: string): ParseResult {
  try {
    const datos = objeto(JSON.parse(crudo), 'mensaje');
    const sobre = envoltorio(datos);
    let mensaje: LiveMessage;
    switch (sobre.kind) {
      case 'snapshot':
        mensaje = parseSnapshot(datos, sobre);
        break;
      case 'position':
        mensaje = parsePosition(datos, sobre);
        break;
      case 'alert':
        mensaje = parseAlert(datos, sobre);
        break;
      default:
        throw new ContractError(`"kind" desconocido: "${sobre.kind}"`);
    }
    return { ok: true, message: mensaje };
  } catch (error) {
    const motivo =
      error instanceof ContractError
        ? error.message
        : error instanceof SyntaxError
          ? 'el frame no es JSON valido'
          : `error inesperado: ${String(error)}`;
    return { ok: false, reason: motivo, raw: recortar(crudo) };
  }
}

function recortar(crudo: string, max = 180): string {
  if (typeof crudo !== 'string') {
    return String(crudo);
  }
  return crudo.length > max ? `${crudo.slice(0, max)}...` : crudo;
}

/* ------------------------------------------------------------------------------------------- */
/* Catalogo de metricas                                                                          */
/* ------------------------------------------------------------------------------------------- */

function parsePunto(valor: unknown, campo: string): MetricPoint {
  if (!Array.isArray(valor) || valor.length < 2) {
    throw new ContractError(`"${campo}" no es un par [segundos, valor]`);
  }
  return [numero(valor[0], `${campo}[0]`), numero(valor[1], `${campo}[1]`)];
}

function parseSerie(valor: unknown, indice: number): MetricSeries {
  const datos = objeto(valor, `series[${indice}]`);
  const bruto = datos['points'];
  if (!Array.isArray(bruto)) {
    throw new ContractError(`"series[${indice}].points" no es una lista`);
  }
  return {
    label: texto(datos['label'], `series[${indice}].label`),
    points: bruto.map((punto, i) => parsePunto(punto, `series[${indice}].points[${i}]`)),
  };
}

/** Parsea `GET /api/metrics`. Nunca lanza: devuelve `null` si la forma no cuadra. */
export function parseMetricsResponse(crudo: unknown): MetricsResponse | null {
  try {
    const datos = objeto(crudo, 'respuesta');
    const bruto = datos['series'];
    if (!Array.isArray(bruto)) {
      throw new ContractError('"series" no es una lista');
    }
    const respuesta: MetricsResponse = {
      panel: texto(datos['panel'], 'panel'),
      ts: texto(datos['ts'], 'ts'),
      stack: stack(datos['stack'], 'stack'),
      series: bruto.map(parseSerie),
      // `nota` solo aparece cuando no hay datos; si viene con series, se conserva igual y la UI
      // decide. La regla del contrato se avisa aparte (ver contractWarnings).
      ...(typeof datos['nota'] === 'string' ? { nota: datos['nota'] } : {}),
      ...(typeof datos['de'] === 'string' ? { de: datos['de'] } : {}),
    };
    return respuesta;
  } catch {
    return null;
  }
}

/**
 * Comprueba las reglas del contrato que no son de forma sino de promesa.
 *
 * Devuelve avisos legibles; vacio significa que la respuesta cumple. Existe por el encargo
 * explicito: si la documentacion y el backend no coinciden, gana el backend y hay que decirlo.
 */
export function contractWarnings(respuesta: MetricsResponse): readonly string[] {
  const avisos: string[] = [];
  if (respuesta.series.length > 0 && respuesta.nota) {
    avisos.push(
      `el panel "${respuesta.panel}" trae series Y nota; el contrato dice que la nota solo aparece cuando no hay datos`,
    );
  }
  if (respuesta.series.length === 0 && !respuesta.nota) {
    avisos.push(
      `el panel "${respuesta.panel}" viene vacio sin nota: el contrato pide explicar por que no hay datos`,
    );
  }
  const conVariosPuntos = respuesta.series.filter((serie) => serie.points.length > 1);
  if (conVariosPuntos.length > 0) {
    // No es un fallo: la forma ya admite varios puntos. Pero conviene saberlo.
    avisos.push(
      `el panel "${respuesta.panel}" trae series con mas de un punto (${conVariosPuntos.length}); la app pinta el ultimo`,
    );
  }
  return avisos;
}

/** Ultimo valor de una serie, o `null` si viene sin puntos. */
export function lastValue(serie: MetricSeries): number | null {
  const ultimo = serie.points[serie.points.length - 1];
  return ultimo ? ultimo[1] : null;
}

/** Momento (segundos epoch) del ultimo punto de una serie. */
export function lastTimestamp(serie: MetricSeries): number | null {
  const ultimo = serie.points[serie.points.length - 1];
  return ultimo ? ultimo[0] : null;
}
