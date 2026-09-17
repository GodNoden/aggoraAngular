/**
 * Contenido del **modo leccion**.
 *
 * Las cinco lecciones viven como scripts en el repositorio del backend
 * (`/home/noei/aggora/scripts/leccion-*.sh`) y se lanzan **desde la terminal, dentro del
 * devcontainer**. Esta pagina no ejecuta nada: es de solo lectura a proposito. Aqui solo se guarda
 * el texto que explica que copiar y que mirar.
 *
 * Cada leccion dice tres cosas:
 *   comando  -> el comando exacto para copiar y pegar.
 *   paneles  -> que panel hay que mirar.
 *   queMirar -> que deberia cambiar, y que NO deberia cambiar (que suele ser lo interesante).
 */

import { PanelName } from '../core/contract';

export interface Lesson {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly script: string;
  /** El comando exacto, en una linea, listo para copiar. */
  readonly command: string;
  /** Paneles del dashboard que hay que mirar, en orden de importancia. */
  readonly panels: readonly PanelName[];
  /** Que deberia verse. */
  readonly expectation: string;
  /** La trampa o el matiz que hace que la leccion valga la pena. */
  readonly twist: string;
  /** Se ejecuta dentro del devcontainer, no en el host. */
  readonly runsIn: 'devcontainer' | 'host';
}

export const LESSONS: readonly Lesson[] = [
  {
    id: 'leccion-1-broker-caido',
    number: 1,
    title: 'A broker goes down and the pipeline does not notice',
    script: 'scripts/leccion-1-broker-caido.sh',
    command: 'bash scripts/leccion-1-broker-caido.sh',
    panels: ['salud', 'lag', 'particiones'],
    expectation:
      'Health: the under-replicated partitions go from 0 to N while the broker is stopped and back to 0 when it returns. The ISR shrinks, a new leader is elected, and the offsets in Partitions keep moving.',
    twist:
      'Lag does NOT move. With 3 replicas and min.insync.replicas=2 the group keeps reading and writing with one copy missing. That is what replicas buy you, and it is the part people expect to break.',
    runsIn: 'devcontainer',
  },
  {
    id: 'leccion-2-veneno-dlt',
    number: 2,
    title: 'The poison pill ends up in the DLT',
    script: 'scripts/leccion-2-veneno-dlt.sh',
    command: 'bash scripts/leccion-2-veneno-dlt.sh',
    panels: ['descartes', 'lag'],
    expectation:
      'Dead letters: the offset of market.ticks.raw.DLT goes up one at a time. Perfect Avro, invalid content: a price of 0 is rejected by validation and parked in the DLT with the header x-dlt-reason.',
    twist:
      'The hole is next to it and this script does not trigger it: a message that is NOT Avro never reaches the DLT, because the deserializer fails before the code runs. Measured consequences: the Spring normalizer wrote 17.4 GB of log in about 6 minutes and the partition stalled, while the Quarkus one revoked its partitions and never came back. The fix (ErrorHandlingDeserializer + DeadLetterPublishingRecoverer, DeserializationFailureHandler) is not implemented.',
    runsIn: 'devcontainer',
  },
  {
    id: 'leccion-3-rebalanceo',
    number: 3,
    title: 'A rebalance, seen from the lag',
    script: 'scripts/leccion-3-rebalanceo.sh',
    command: 'bash scripts/leccion-3-rebalanceo.sh',
    panels: ['lag', 'particiones'],
    expectation:
      'A second normalizer starts with the SAME group.id, so the six partitions are split 6/0 then 3/3. Lag spikes for a few seconds during the rebalance and the offsets never stop.',
    twist:
      'With different group ids there would be no rebalance at all: each instance would read all six partitions. The interesting number is not the spike, it is that the offsets do not pause while it happens.',
    runsIn: 'devcontainer',
  },
  {
    id: 'leccion-4-exactly-once',
    number: 4,
    title: 'Exactly-once, honestly',
    script: 'scripts/leccion-4-exactly-once.sh',
    command: 'bash scripts/leccion-4-exactly-once.sh',
    panels: ['transacciones', 'lag'],
    expectation:
      'Transactions comes back empty WITH its note. The script wraps ExactlyOnceRaceCheck.java, which proves against the real cluster that the aborted transaction does not exist under read_committed and does exist in the log under read_uncommitted.',
    twist:
      'There is no committed/aborted counter in Prometheus to show: kafka-exporter only exposes offsets, lag, groups and ISR, and the kafka_producer_txn_*_time_ns_total series are TIMES, not counts. A panel that stays empty and says why is better than a made-up number. Day to day you watch the lag of orders.executions.',
    runsIn: 'devcontainer',
  },
  {
    id: 'leccion-5-streams-muerto',
    number: 5,
    title: 'The engine is dead but the process is alive',
    script: 'scripts/leccion-5-streams-muerto.sh',
    command: 'bash scripts/leccion-5-streams-muerto.sh',
    panels: ['salud', 'lag'],
    expectation:
      'The GlobalKTable checkpoint of analytics-streams is broken (an offset that no longer exists in the compacted topic market.fx.reference) and the service restarts. The engine stays in ERROR while the process is still up: /actuator/health returns 503, /analytics returns 503 and aggora_kafka_streams_running drops to 0.',
    twist:
      'The lesson is not "break things". It is that a service should not decide to kill itself (who starts a process is the supervisor) and that what warns you is the probe, not the process list. The trap restores the checkpoint and restarts the service.',
    runsIn: 'devcontainer',
  },
];

/** El chequeo ejecutable del contrato, en el repo del backend. */
export const SMOKE_COMMAND = 'bash scripts/dashboard-smoke.sh';
