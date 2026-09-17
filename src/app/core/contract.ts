/**
 * Tipos del contrato del backend Aggora (CONTRACT.md, v1).
 *
 * Regla: aqui solo se describe lo que el backend dice que manda. Si el backend anade un campo, se
 * anade aqui y el compilador ensena todos los sitios que hay que tocar. Todo es de solo lectura:
 * no hay ni un tipo de peticion de escritura.
 */

/** Version del contrato que habla esta app. */
export const CONTRACT_VERSION = 1;

/** Los dos stacks del proyecto: el mismo pipeline implementado dos veces. */
export type Stack = 'spring' | 'quarkus';

export const STACKS: readonly Stack[] = ['spring', 'quarkus'];

/** Modo del selector: un stack o los dos en paralelo (la firma del proyecto). */
export type StackMode = Stack | 'both';

/**
 * Las bases HTTP de un stack.
 *
 * El contrato fija puertos y rutas, asi que estos extremos son parte del contrato: aqui viven los
 * tipos y `src/environments/` decide los valores.
 */
export interface StackEndpoints {
  /** Etiqueta para la UI. */
  readonly label: string;
  /** Base HTTP del gateway: WebSocket de eventos y catalogo de metricas. */
  readonly gateway: string;
  /** Base HTTP de la consulta interactiva (el panel del state store). */
  readonly analytics: string;
  /** Sonda de salud. */
  readonly health: string;
  /** Ruta de la sonda dentro de `health`. */
  readonly healthPath: string;
  /**
   * Ruta del WebSocket de eventos.
   *
   * Es una ruta y no una URL completa a proposito: en desarrollo la app habla con **su propio
   * origen** y el dev server hace de proxy (ver `proxy.conf.json`), asi el navegador no tiene que
   * saltar de `localhost:4200` a `localhost:8089`. Ese salto es lo que fallaba en este equipo: la
   * app la sirve WSL y el navegador corre en Windows, y ahi `localhost:8089` no es el mismo host.
   */
  readonly wsPath: string;
}

/** Sobre comun a los tres mensajes del WebSocket. */
export interface Envelope {
  /** Version del contrato. Hoy 1. */
  readonly v: number;
  readonly kind: string;
  /** Quien manda el mensaje. */
  readonly stack: Stack;
  /** Hora del servidor, ISO-8601 UTC. */
  readonly ts: string;
}

/** Ultimo tick conocido de un simbolo. Los decimales de Avro viajan como texto. */
export interface SymbolTick {
  /** Precio como texto: en dinero no se usa coma flotante. */
  readonly price: string;
  readonly currency: string;
  readonly size: number;
  /** REFERENCE (tabla de referencia) o SYNTHETIC (generado). */
  readonly source: string;
  /** Cuando se genero el tick. */
  readonly at: string;
}

/** Foto por segundo: el ultimo valor de cada simbolo, no una lista de ticks. */
export interface SnapshotMessage extends Envelope {
  readonly kind: 'snapshot';
  /** Ticks consumidos de Kafka durante el ultimo segundo. */
  readonly ticksIn: number;
  /** Simbolos presentes en esta foto (uno por simbolo). */
  readonly ticksOut: number;
  /** Clave = simbolo. Un simbolo que deja de cotizar mantiene su ultimo precio. */
  readonly symbols: Readonly<Record<string, SymbolTick>>;
}

/** Posicion de una cuenta. Se manda al momento, sin esperar al segundo. */
export interface PositionMessage extends Envelope {
  readonly kind: 'position';
  readonly account: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly averageCost: string;
  readonly realizedPnl: string;
  readonly exposure: string;
  readonly currency: string;
  /** Aviso de margen. */
  readonly marginBreach: boolean;
}

export const SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;

export type Severity = (typeof SEVERITIES)[number];

/** Alerta. Se manda al momento. `severity` es CRITICAL, WARNING o INFO. */
export interface AlertMessage extends Envelope {
  readonly kind: 'alert';
  readonly severity: Severity;
  readonly type: string;
  readonly subject: string;
  readonly detail: string;
  readonly value: string;
  readonly raisedAt: string;
}

export type LiveMessage = SnapshotMessage | PositionMessage | AlertMessage;

/**
 * Resultado del parseo de un frame del WebSocket.
 *
 * Un frame invalido no puede tumbar la app: el parseo nunca lanza, devuelve un fallo explicado.
 */
export type ParseResult =
  | { readonly ok: true; readonly message: LiveMessage }
  | { readonly ok: false; readonly reason: string; readonly raw: string };

/* ------------------------------------------------------------------------------------------- */
/* Catalogo de metricas                                                                          */
/* ------------------------------------------------------------------------------------------- */

export const PANELS = [
  'pulso',
  'lag',
  'particiones',
  'transacciones',
  'descartes',
  'salud',
  'comparativa',
] as const;

export type PanelName = (typeof PANELS)[number];

/** Paneles que `comparativa` sabe comparar (`&de=<panel>`). Su valor por defecto es `pulso`. */
export const COMPARABLE_PANELS = [
  'pulso',
  'lag',
  'particiones',
  'descartes',
  'salud',
  'transacciones',
] as const;

export type ComparablePanel = (typeof COMPARABLE_PANELS)[number];

/** Un punto es [segundos epoch, valor]. */
export type MetricPoint = readonly [number, number];

export interface MetricSeries {
  /** Nombre legible: grupo de consumidores, topic/particion, target... */
  readonly label: string;
  /** Hoy un punto por serie (consulta instantanea); la forma ya admite varios. */
  readonly points: readonly MetricPoint[];
}

/**
 * Respuesta de `GET /api/metrics?panel=<nombre>`.
 *
 * `nota` aparece SOLO cuando `series` viene vacio, explicando por que. Nunca se inventa una serie.
 */
export interface MetricsResponse {
  readonly panel: string;
  readonly ts: string;
  readonly stack: Stack;
  readonly series: readonly MetricSeries[];
  /** Solo cuando no hay datos. */
  readonly nota?: string;
  /** Solo en `comparativa`: el panel que se esta comparando. */
  readonly de?: string;
}

/** Error del catalogo: 400 panel desconocido / 400 comparativa no soporta / 502 prometheus. */
export interface MetricsError {
  readonly error: string;
  readonly detalle?: readonly string[] | string;
}
