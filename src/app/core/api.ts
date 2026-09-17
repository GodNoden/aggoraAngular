/**
 * Lo minimo para hablar con el backend: URLs, un GET con tiempo limite y el parseo defensivo.
 *
 * Regla de la casa, y viene de un fallo real de este proyecto: **nada espera para siempre**. Una
 * peticion sin tiempo limite deja un panel en "cargando" y no distingue "va lento" de "no hay
 * nadie", que es justo lo que hay que saber.
 */

import { Frame, PATHS, PanelData, Stack, Tick, Window, severityOf } from './types';

/** Cuando se da por perdida una peticion (ms). */
export const TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ URLs */

/** Une una base con un camino sin duplicar barras. */
function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Base absoluta del WebSocket.
 *
 * La regla no es mirar el esquema de la base, es **mirar el de la pagina**: una pagina servida por
 * HTTPS no puede abrir `ws://` aunque la base diga `http://`, porque el navegador lo bloquea como
 * contenido mixto. Con base vacia se usa el host de la propia pagina.
 */
export function socketUrl(stack: Stack): string {
  const protocolo = typeof location === 'undefined' ? 'http:' : location.protocol;
  const host = typeof location === 'undefined' ? 'localhost' : location.host;
  const esquema = protocolo === 'https:' ? 'wss:' : 'ws:';
  return `${esquema}//${host}${PATHS[stack].ws}`;
}

/** URL del catalogo para un panel. */
export function catalogUrl(stack: Stack, panel: string, de?: string): string {
  const params = new URLSearchParams({ panel });
  if (de) {
    params.set('de', de);
  }
  return `${join(PATHS[stack].gateway, 'metrics')}?${params.toString()}`;
}

/**
 * URL de la consulta interactiva al state store.
 *
 * Ojo: `PATHS[stack].analytics` **ya es** la ruta (`/analytics`). Si se le anadiese otra vez saldria
 * `/analytics/analytics` y el backend contestaria 404; ya paso una vez en este proyecto, y por eso
 * hay un test que lo fija.
 */
export function analyticsUrl(stack: Stack, symbol: string, minutes: number): string {
  const params = new URLSearchParams({ symbol, minutes: String(minutes) });
  return `${PATHS[stack].analytics}?${params.toString()}`;
}

/* ------------------------------------------------------------------ GET */

/** Un fallo de red ya explicado, con la URL dentro. */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Pide una URL y devuelve el cuerpo como texto.
 *
 * El sello `_t` de la URL evita que el navegador reutilice una respuesta anterior de la cache: los
 * mismos paneles se piden cada pocos segundos y aqui se quiere medir **esta** peticion.
 */
export async function getText(url: string, signal?: AbortSignal): Promise<string> {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), TIMEOUT_MS);
  const abortar = () => control.abort();
  signal?.addEventListener('abort', abortar, { once: true });
  try {
    const separador = url.includes('?') ? '&' : '?';
    const respuesta = await fetch(`${url}${separador}_t=${Date.now()}`, { signal: control.signal });
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new FetchError(`HTTP ${respuesta.status} en ${url}`, url, respuesta.status);
    }
    return texto;
  } catch (error) {
    if (error instanceof FetchError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new FetchError(`no hubo respuesta en ${TIMEOUT_MS / 1000} s: ${url}`, url);
    }
    throw new FetchError(`fallo de red en ${url}`, url);
  } finally {
    clearTimeout(corte);
    signal?.removeEventListener('abort', abortar);
  }
}

/* ------------------------------------------------------------------ parseo */

/** Intenta leer JSON. Devuelve `null` si el texto no es JSON. */
export function parseJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function numero(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

/** Convierte la respuesta del catalogo. `null` si la forma no cuadra. */
export function parsePanel(crudo: unknown, panel: string, stack: Stack): PanelData | null {
  if (!esObjeto(crudo) || !Array.isArray(crudo['series'])) {
    return null;
  }
  const series = [];
  for (const bruta of crudo['series']) {
    if (!esObjeto(bruta) || typeof bruta['label'] !== 'string') {
      continue;
    }
    const puntos = [];
    for (const punto of Array.isArray(bruta['points']) ? bruta['points'] : []) {
      if (!Array.isArray(punto) || punto.length < 2) {
        continue;
      }
      const segundos = numero(punto[0]);
      const valor = numero(punto[1]);
      if (segundos !== null && valor !== null) {
        puntos.push([segundos, valor] as const);
      }
    }
    series.push({ label: bruta['label'], points: puntos });
  }
  const nota = texto(crudo['nota']);
  const de = texto(crudo['de']);
  return {
    panel: texto(crudo['panel']) || panel,
    ts: texto(crudo['ts']),
    stack,
    series,
    ...(nota ? { nota } : {}),
    ...(de ? { de } : {}),
  };
}

/** Convierte un frame del WebSocket. `null` si no sigue el contrato: nunca lanza. */
export function parseFrame(crudo: string): Frame | null {
  const datos = parseJson(crudo);
  if (!esObjeto(datos)) {
    return null;
  }
  const ts = texto(datos['ts']);
  switch (datos['kind']) {
    case 'snapshot': {
      const ticksIn = numero(datos['ticksIn']);
      const ticksOut = numero(datos['ticksOut']);
      if (ticksIn === null || ticksOut === null) {
        return null;
      }
      const symbols: Record<string, Tick> = {};
      const brutos = esObjeto(datos['symbols']) ? datos['symbols'] : {};
      for (const [simbolo, bruto] of Object.entries(brutos)) {
        if (!esObjeto(bruto)) {
          continue;
        }
        symbols[simbolo] = {
          price: texto(bruto['price']),
          currency: texto(bruto['currency']),
          size: numero(bruto['size']) ?? 0,
          source: texto(bruto['source']),
          at: texto(bruto['at']),
        };
      }
      return { kind: 'snapshot', snapshot: { ts, ticksIn, ticksOut, symbols } };
    }
    case 'position':
      return {
        kind: 'position',
        position: {
          ts,
          account: texto(datos['account']),
          symbol: texto(datos['symbol']),
          quantity: numero(datos['quantity']) ?? 0,
          averageCost: texto(datos['averageCost']),
          realizedPnl: texto(datos['realizedPnl']),
          exposure: texto(datos['exposure']),
          currency: texto(datos['currency']),
          marginBreach: datos['marginBreach'] === true,
        },
      };
    case 'alert':
      return {
        kind: 'alert',
        alert: {
          ts,
          severity: severityOf(texto(datos['severity'])),
          type: texto(datos['type']),
          subject: texto(datos['subject']),
          detail: texto(datos['detail']),
          value: texto(datos['value']),
        },
      };
    default:
      return null;
  }
}

/** Convierte la respuesta de `/analytics`. Acepta la lista real y, por tolerancia, `{windows}`. */
export function parseWindows(crudo: unknown): readonly Window[] {
  const lista = Array.isArray(crudo)
    ? crudo
    : esObjeto(crudo) && Array.isArray(crudo['windows'])
      ? crudo['windows']
      : [];
  const ventanas: Window[] = [];
  for (const bruta of lista) {
    if (!esObjeto(bruta) || typeof bruta['symbol'] !== 'string') {
      continue;
    }
    ventanas.push({
      symbol: bruta['symbol'],
      windowKind: texto(bruta['windowKind']),
      windowStart: texto(bruta['windowStart']),
      windowEnd: texto(bruta['windowEnd']),
      ticks: numero(bruta['ticks']) ?? 0,
      volume: numero(bruta['volume']) ?? 0,
      vwap: numero(bruta['vwap']) ?? 0,
      movingAverage: numero(bruta['movingAverage']) ?? 0,
      volatility: numero(bruta['volatility']) ?? 0,
      lastPrice: numero(bruta['lastPrice']) ?? 0,
    });
  }
  return ventanas;
}
