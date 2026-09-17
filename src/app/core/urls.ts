/**
 * Helpers de URL: el unico sitio donde se decide el esquema.
 *
 * La trampa del despliegue: una pagina servida por HTTPS no puede abrir `ws://` (contenido mixto,
 * el navegador lo bloquea). En vez de escribir el esquema a mano, se elige segun el protocolo de la
 * pagina. El backend ademas honra `X-Forwarded-*`, asi que detras de un tunel o un reverse proxy
 * funciona sin tocar nada.
 *
 * `protocol` y `origin` son parametros con valor por defecto (los de la pagina) para poder probar la
 * conversion http->ws y https->wss sin tocar `window.location`, que en un navegador real es de solo
 * lectura. En produccion nunca se pasan.
 */

import { Stack, StackEndpoints } from '../core/contract';

/** Lo que la app necesita saber de la pagina donde vive. */
export interface PageContext {
  readonly protocol: string;
  readonly origin: string;
}

/** El contexto de la pagina, o vacio si no hay `location` (tests en Node). */
export function pageContext(): PageContext {
  if (typeof location === 'undefined') {
    return { protocol: '', origin: '' };
  }
  return { protocol: location.protocol, origin: location.origin };
}

/**
 * Convierte una base HTTP (o vacia) en una base absoluta.
 *
 * Base vacia = "el mismo host que sirve la pagina": es lo comodo cuando el gateway publico y el
 * dashboard comparten dominio, y evita recompilar al cambiar de dominio.
 */
export function httpBase(base: string, page: PageContext = pageContext()): string {
  if (!base) {
    return page.origin;
  }
  // Una ruta relativa ("/api") se resuelve contra el origen de la pagina: es lo normal en
  // desarrollo, donde el dev server hace de proxy y todo es del mismo origen.
  if (base.startsWith('/')) {
    return `${page.origin}${base}`.replace(/\/+$/, '');
  }
  return base.replace(/\/+$/, '');
}

/**
 * Base del WebSocket.
 *
 * La regla no es "mira el esquema de la base", es **mira el esquema de la pagina**: una pagina
 * servida por HTTPS no puede abrir `ws://` aunque la base diga `http://`, porque el navegador lo
 * bloquea como contenido mixto. Da igual que la base sea `http://gateway:8089` de un reverse proxy
 * local o `https://aggora.midominio.com`: si la pagina va por https, sale `wss://`.
 */
export function wsBase(base: string, page: PageContext = pageContext()): string {
  const absoluta = httpBase(base, page);
  if (!absoluta) {
    return '';
  }
  const url = new URL(absoluta);
  const paginaSegura = page.protocol === 'https:';
  url.protocol = paginaSegura || url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

/**
 * URL completa del WebSocket de eventos de un stack.
 *
 * `wsPath` es una ruta del mismo origen de la pagina; si algun dia el gateway vive en otro host,
 * `wsPath` puede ser una URL absoluta y `wsBase` se encarga del esquema.
 */
export function wsUrl(endpoints: StackEndpoints, page: PageContext = pageContext()): string {
  if (/^wss?:\/\//i.test(endpoints.wsPath)) {
    return endpoints.wsPath;
  }
  if (/^https?:\/\//i.test(endpoints.wsPath)) {
    return `${wsBase(endpoints.wsPath, page)}${new URL(endpoints.wsPath).pathname}`;
  }
  return `${wsBase('', page)}${endpoints.wsPath}`;
}

/** URL de la consulta interactiva del state store. */
export function analyticsUrl(
  endpoints: StackEndpoints,
  symbol: string,
  minutes: number,
): string {
  const params = new URLSearchParams({ symbol, minutes: String(minutes) });
  return `${httpBase(endpoints.analytics)}/analytics?${params.toString()}`;
}

/** URL de la sonda de salud del stack. */
export function healthUrl(endpoints: StackEndpoints): string {
  return `${httpBase(endpoints.health)}${endpoints.healthPath}`;
}

/** URL del catalogo de metricas. `de` solo aplica al panel `comparativa`. */
export function metricsUrl(
  endpoints: StackEndpoints,
  panel: string,
  de?: string,
): string {
  const params = new URLSearchParams({ panel });
  if (de) {
    params.set('de', de);
  }
  // `gateway` ya es la base del catalogo (en desarrollo "/api", que resuelve el proxy del dev
  // server). Antes se le anadia otro "/api" y salia /api/api/metrics: el test lo cazo.
  return `${httpBase(endpoints.gateway)}/metrics?${params.toString()}`;
}

/** Etiqueta legible de un stack. */
export const STACK_LABEL: Readonly<Record<Stack, string>> = {
  spring: 'Spring',
  quarkus: 'Quarkus',
};
