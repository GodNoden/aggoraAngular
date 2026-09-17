/**
 * Capa HTTP minima sobre `fetch`.
 *
 * Por que no se usa `HttpClient` de Angular: en este entorno sus peticiones **no resuelven nunca**
 * (los paneles se quedan en `loading` para siempre), mientras que la misma peticion con `fetch`
 * responde en 150 ms. Esta medido dentro de la propia app: `fetch` 200 en 154 ms, `HttpClient` sin
 * responder. No es la red ni el backend ni el proxy: los tres devuelven 200 y el WebSocket abre.
 *
 * Asi que aqui esta lo unico que la app necesita de un cliente HTTP, en 60 lineas y sin dependencias:
 *
 *  - **Timeout** con `AbortController`: ninguna peticion se queda colgada. Es la regla de la casa
 *    (un panel no puede estar en `loading` eternamente) y aqui se cumple en el origen.
 *  - **Errores explicados**: se distingue "no hubo respuesta a tiempo" de "el backend contesto
 *    HTTP 4xx/5xx", y en los dos casos el mensaje lleva la URL.
 *  - Nada de JSON automatico: el parseo del contrato ya es defensivo y vive en `contract.parser.ts`.
 */

/** Cuanto se espera una respuesta antes de darla por perdida (ms). */
export const REQUEST_TIMEOUT_MS = 10000;

/** Error de una peticion, ya listo para ensenar en la UI. */
export class HttpFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
    /** Cuerpo del error, si el backend mando uno (el catalogo manda `{error, detalle}`). */
    readonly body: unknown = null,
    readonly timeout = false,
  ) {
    super(message);
    this.name = 'HttpFetchError';
  }
}

/** Pide una URL y devuelve el cuerpo crudo. Lanza `HttpFetchError` con la URL dentro. */
export async function getJson(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), timeoutMs);
  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      // Sin cache: estos paneles son el estado de ahora, no un documento.
      cache: 'no-store',
    });
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new HttpFetchError(
        `HTTP ${respuesta.status} en ${url}`,
        url,
        respuesta.status,
        parsearCuerpo(texto),
      );
    }
    return parsearCuerpo(texto);
  } catch (error) {
    if (error instanceof HttpFetchError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpFetchError(`no hubo respuesta en ${timeoutMs / 1000} s: ${url}`, url, null, null, true);
    }
    throw new HttpFetchError(`fallo de red en ${url}: ${String(error)}`, url, null);
  } finally {
    clearTimeout(corte);
  }
}

/** Intenta leer JSON; si no lo es, devuelve el texto tal cual. */
function parsearCuerpo(texto: string): unknown {
  if (!texto) {
    return null;
  }
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/**
 * Frase legible para la UI a partir del error.
 *
 * Se mantiene el mensaje del backend cuando lo hay (`{error, detalle}`), porque el catalogo cerrado
 * explica ahi por que rechaza un panel.
 */
export function describirErrorHttp(error: unknown, contexto: string): string {
  if (!(error instanceof HttpFetchError)) {
    return `${contexto}: ${String(error)}`;
  }
  if (error.timeout) {
    return error.message;
  }
  const cuerpo = error.body as { error?: unknown; detalle?: unknown } | null;
  if (cuerpo && typeof cuerpo === 'object' && 'error' in cuerpo) {
    const detalle = cuerpo.detalle;
    const cola = Array.isArray(detalle)
      ? ` | catalogo: ${detalle.join(', ')}`
      : typeof detalle === 'string'
        ? ` | ${detalle}`
        : '';
    return `${error.message}: ${String(cuerpo.error)}${cola}`;
  }
  return error.message;
}
