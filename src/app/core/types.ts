/**
 * Lo que manda el backend, tal cual. Nada mas y nada menos.
 *
 * Todo esto es de solo lectura: el contrato de Aggora no tiene un solo endpoint de escritura. Si el
 * backend anade un campo se anade aqui y el compilador ensena los sitios que hay que tocar.
 */

/** Las dos implementaciones del mismo pipeline. */
export type Stack = 'spring' | 'quarkus';

export const STACKS: readonly Stack[] = ['spring', 'quarkus'];

/** Que se esta mirando: una implementacion o las dos, para comparar. */
export type View = Stack | 'both';

export const STACK_LABEL: Readonly<Record<Stack, string>> = {
  spring: 'Spring Boot',
  quarkus: 'Quarkus',
};

/**
 * Los dos caminos del backend, ya resueltos por el proxy (ver `tools/serve-verify.mjs`).
 *
 * La app no conoce puertos: habla siempre con su propio origen y el proxy decide a que servicio va
 * cada prefijo. Es lo que hace falta en produccion y de paso evita CORS.
 */
export interface Paths {
  /** Catalogo de metricas del stack y su WebSocket. */
  readonly gateway: string;
  readonly ws: string;
  /** Consulta interactiva al state store. */
  readonly analytics: string;
}

export const PATHS: Readonly<Record<Stack, Paths>> = {
  spring: { gateway: '/api', ws: '/ws', analytics: '/analytics' },
  quarkus: { gateway: '/q/api', ws: '/q/ws', analytics: '/analytics' },
};

/* ------------------------------------------------------------------ por WebSocket */

/** Un tick: el ultimo precio conocido de un simbolo. El dinero viaja como texto. */
export interface Tick {
  readonly price: string;
  readonly currency: string;
  readonly size: number;
  readonly source: string;
  readonly at: string;
}

/** La foto que llega una vez por segundo: el ultimo valor de cada simbolo, no una lista. */
export interface Snapshot {
  readonly ts: string;
  /** Ticks consumidos de Kafka en ese segundo. */
  readonly ticksIn: number;
  /** Simbolos presentes en la foto. */
  readonly ticksOut: number;
  readonly symbols: Readonly<Record<string, Tick>>;
}

/** Una posicion de una cuenta. Los decimales de Avro viajan como texto, no como numero. */
export interface Position {
  readonly ts: string;
  readonly account: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly averageCost: string;
  readonly realizedPnl: string;
  readonly exposure: string;
  readonly currency: string;
  readonly marginBreach: boolean;
}

/** Las gravedades del contrato. */
export const SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;

/**
 * Si el backend estrena una gravedad, se queda en INFO en vez de perder la alerta: enterarse de que
 * algo pasa importa mas que la etiqueta.
 */
export function severityOf(valor: string): string {
  const bruta = valor.toUpperCase();
  return (SEVERITIES as readonly string[]).includes(bruta) ? bruta : 'INFO';
}

/** Una alerta: viaja al momento, no espera al segundo. */
export interface Alert {
  readonly ts: string;
  readonly severity: string;
  readonly type: string;
  readonly subject: string;
  readonly detail: string;
  readonly value: string;
}

/** Un frame del WebSocket, ya interpretado. Lo que no cuadra se rechaza con un motivo. */
export type Frame =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly kind: 'position'; readonly position: Position }
  | { readonly kind: 'alert'; readonly alert: Alert };

/* ------------------------------------------------------------------ por GET */

/** Una serie del catalogo: un nombre y sus puntos `[segundos, valor]`. */
export interface Series {
  readonly label: string;
  /** Hoy trae un solo punto (consulta instantanea); la forma admite varios. */
  readonly points: readonly (readonly [number, number])[];
}

/** Respuesta de `GET <gateway>/metrics?panel=<nombre>`. */
export interface PanelData {
  readonly panel: string;
  readonly ts: string;
  readonly stack: Stack;
  readonly series: readonly Series[];
  /** Explica por que no hay datos. Aparece **solo** cuando `series` viene vacio. */
  readonly nota?: string;
}

/**
 * Una ventana calculada por el motor de streams, que es lo que devuelve la consulta interactiva.
 * El contrato documenta la URL pero no esta forma: se comprobo contra el backend.
 */
export interface Window {
  readonly symbol: string;
  readonly windowKind: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly ticks: number;
  readonly volume: number;
  readonly vwap: number;
  readonly movingAverage: number;
  readonly volatility: number;
  readonly lastPrice: number;
}

/** Ultimo valor de una serie, o `null` si no trae puntos. */
export function value(series: Series | undefined | null): number | null {
  const punto = series?.points[series.points.length - 1];
  return punto ? punto[1] : null;
}

/** Busca una serie por su nombre exacto. */
export function find(series: readonly Series[], label: string): Series | undefined {
  return series.find((candidata) => candidata.label === label);
}
