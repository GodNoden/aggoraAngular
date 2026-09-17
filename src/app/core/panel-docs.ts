/**
 * Ficha de cada panel: el nombre, la frase de "que estas viendo" y el "por que importa".
 *
 * Esto es lo que convierte el dashboard en material de aprendizaje y no en una tabla bonita. Los
 * textos son deliberadamente llanos: si hay que explicar un panel con una formula, el panel esta mal
 * explicado. Estan en ingles porque el repo es la carta de presentacion.
 */

import { PanelName, ComparablePanel } from '../core/contract';

export interface PanelDoc {
  readonly panel: PanelName;
  /** Titulo corto para la cabecera del panel. */
  readonly title: string;
  /** Que estas viendo, en una frase. */
  readonly what: string;
  /** Por que importa. */
  readonly why: string;
  /** Panel que se compara cuando se pide `comparativa&de=`. */
  readonly comparableAs?: ComparablePanel;
}

export const PANEL_DOCS: Readonly<Record<PanelName, PanelDoc>> = {
  pulso: {
    panel: 'pulso',
    title: 'Pulse',
    comparableAs: 'pulso',
    what: 'Ticks per second going into market.ticks.raw and coming out of the canonical topics.',
    why: 'Two lines that rise and fall together mean the normalizer keeps up. If the input rises and the output does not, it fell behind. It is the cheapest health check in the whole pipeline.',
  },
  lag: {
    panel: 'lag',
    title: 'Consumer lag',
    comparableAs: 'lag',
    what: 'How far behind each consumer group is, one value per group.',
    why: 'Near zero and saw-toothing is healthy: the consumer catches up and waits. Rising without coming back means somebody cannot keep up, and the first thing to check is whether it is a capacity problem or a stuck partition.',
  },
  particiones: {
    panel: 'particiones',
    title: 'Partitions',
    comparableAs: 'particiones',
    what: 'The current offset of every partition: the log moving forward.',
    why: 'Each partition is a line that climbs. A flat line means that partition is not receiving (or is not being written to). A jump means a burst. It is the only panel where you can see the shape of the load.',
  },
  descartes: {
    panel: 'descartes',
    title: 'Dead letters',
    comparableAs: 'descartes',
    what: 'Offsets of the DLT topics and the retry topics: what could not be processed.',
    why: 'Flat at zero is green: nothing is being thrown away. Every step is a message that went to the DLT and needs its header read. Retry offsets climbing without the DLT climbing means something is being retried and might still make it.',
  },
  salud: {
    panel: 'salud',
    title: 'Health',
    comparableAs: 'salud',
    what: 'Prometheus targets, the Kafka Streams engine per stack, and under-replicated partitions.',
    why: 'Who is alive and who only looks like it. A target at 0 is a scrape that failed. An engine at 0 with the process still up is lesson 5: the probe knows, the process list does not. Under-replicated above 0 means Kafka is running with fewer copies than it wants.',
  },
  transacciones: {
    panel: 'transacciones',
    title: 'Transactions',
    comparableAs: 'transacciones',
    what: 'Committed versus aborted transactions.',
    why: 'It is empty on purpose and the backend explains why: that counter does not exist in this Prometheus. Exactly-once is proven by scripts/ExactlyOnceRaceCheck.java and watched through the lag of orders.executions. A gap that is admitted is worth more than a number that is invented.',
  },
  comparativa: {
    panel: 'comparativa',
    title: 'Side by side',
    what: 'The same panel, with its Spring series and its Quarkus series together.',
    why: 'The signature of the project: one pipeline, two complete implementations. Same shape means the same behaviour, which is what lets you trust either one. This is the view that catches a divergence early.',
  },
};

/** Orden de los paneles en la pantalla: del latido del sistema a la comparacion. */
export const PANEL_ORDER: readonly PanelName[] = [
  'pulso',
  'lag',
  'particiones',
  'descartes',
  'salud',
  'transacciones',
];

/** Serie destacada de cada panel simple, la que se ensena en la vista compacta "both". */
export const HEADLINE_SERIES: Readonly<Record<string, string | null>> = {
  pulso: 'entrada',
  // El lag del normalizer de Spring: es el que se mueve en la leccion 3.
  lag: 'ingestion-normalizer',
  // market.ticks.raw/0 como representante del log.
  particiones: 'market.ticks.raw/0',
  // El DLT de Spring: es el que sube en la leccion 2.
  descartes: 'market.ticks.raw.DLT/0',
  salud: 'under-replicated/market.ticks.raw',
  transacciones: null,
};

/** Colores por stack, para el modo lado a lado. Spring verde, Quarkus azul. */
export function colorFor(label: string, stack: 'spring' | 'quarkus'): string {
  // Si la etiqueta ya dice el stack (comparativa viene como "spring/..." y "quarkus/..."),
  // manda la etiqueta: asi el color sigue a la implementacion, no a la columna.
  const etiqueta = label.toLowerCase();
  if (etiqueta.startsWith('quarkus/') || etiqueta.endsWith('-q')) {
    return '#5aa9ff';
  }
  if (etiqueta.startsWith('spring/')) {
    return '#3ddc97';
  }
  return stack === 'spring' ? '#3ddc97' : '#5aa9ff';
}

/** Paleta para partir un panel con muchas series (particiones, descartes, salud). */
export const SERIES_PALETTE: readonly string[] = [
  '#3ddc97',
  '#5aa9ff',
  '#ffb454',
  '#ff6b8b',
  '#b18cff',
  '#4dd0e1',
  '#a3e635',
  '#f97316',
  '#e879f9',
  '#38bdf8',
];
