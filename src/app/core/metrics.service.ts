/**
 * Servicio del catalogo de metricas (`GET /api/metrics?panel=<nombre>`).
 *
 *  - Se piden los paneles cada `metricsIntervalMs` (5-10 s), **no** cada segundo: es de buena
 *    educacion con Prometheus y el dato de estos paneles (offsets, lag, ISR) no cambia de interes
 *    en un segundo. El WebSocket, que si es por segundo, va por otro camino.
 *  - El catalogo es **cerrado**: el panel es la unica entrada y no se acepta PromQL libre. Aqui
 *    nunca se construye una consulta.
 *  - Si un panel devuelve `series: []`, se guarda la `nota` y se muestra "no hay dato". **No se
 *    rellena con nada.**
 */

import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import {
  ComparablePanel,
  MetricSeries,
  MetricsResponse,
  PANELS,
  PanelName,
  Stack,
  StackEndpoints,
  STACKS,
} from '../core/contract';
import { contractWarnings, lastValue, parseMetricsResponse } from '../core/contract.parser';
import { metricsUrl } from '../core/urls';
import { REQUEST_TIMEOUT_MS, describirErrorHttp, getJson } from './http';

/** Estado de un panel en un stack. */
export type PanelStatus = 'loading' | 'ok' | 'empty' | 'error';

export { REQUEST_TIMEOUT_MS } from './http';

export interface PanelState {
  readonly panel: PanelName;
  readonly stack: Stack;
  readonly status: PanelStatus;
  readonly data: MetricsResponse | null;
  /** Por que no hay datos: la `nota` del backend o el error de red. */
  readonly note: string | null;
  /** Avisos de contrato (p. ej. series y nota a la vez). */
  readonly warnings: readonly string[];
  /** Cuando se pidio por ultima vez (ms epoch). */
  readonly fetchedAt: number | null;
  /** Cuando se lanzo la peticion en curso, para poder avisar si tarda de mas. */
  readonly requestedAt: number | null;
  /** Cuanto tardo la peticion (ms). */
  readonly elapsedMs: number | null;
}

const INICIAL = (panel: PanelName, stack: Stack): PanelState => ({
  panel,
  stack,
  status: 'loading',
  data: null,
  note: null,
  warnings: [],
  fetchedAt: null,
  elapsedMs: null,
  requestedAt: null,
});

/** Los paneles que se piden de uno en uno. `comparativa` se pide aparte, con su `de`. */
const PANELES_SIMPLES = PANELS.filter((panel) => panel !== 'comparativa') as readonly PanelName[];

@Injectable({ providedIn: 'root' })
export class MetricsService {

  private readonly endpoints: Readonly<Record<Stack, StackEndpoints>> = {
    spring: environment.spring,
    quarkus: environment.quarkus,
  };

  constructor() {
    trazaArranque('MetricsService: construido');
  }

  private readonly estados = signal<Readonly<Record<string, PanelState>>>(
    Object.fromEntries(
      STACKS.flatMap((stack) =>
        PANELES_SIMPLES.map((panel) => [clave(panel, stack), INICIAL(panel, stack)] as const),
      ),
    ),
  );

  private readonly comparativaDe = signal<ComparablePanel>('pulso');
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private pidiendo = false;
  /** Cuando empezo el ciclo en curso, para poder detectar un ciclo colgado. */
  private inicioCiclo: number | null = null;
  /** Ciclos descartados por quedarse colgados: si esto sube, algo no responde. */
  private ciclosDescartados = 0;

  /** Panel que se esta comparando en el modo lado a lado. */
  readonly comparisonPanel: Signal<ComparablePanel> = this.comparativaDe.asReadonly();

  /** Estado de todos los paneles. */
  readonly panels: Signal<Readonly<Record<string, PanelState>>> = this.estados.asReadonly();

  /** Cada cuanto se refresca, para ensenarlo en la UI. */
  readonly intervalMs = environment.metricsIntervalMs;

  /** Momento del ultimo refresco completo. */
  readonly lastRefresh = computed(() => {
    const tiempos = Object.values(this.estados())
      .map((estado) => estado.fetchedAt)
      .filter((valor): valor is number => valor !== null);
    return tiempos.length > 0 ? Math.max(...tiempos) : null;
  });

  /** Hay algun panel con error de red o de catalogo. */
  readonly hasErrors = computed(() =>
    Object.values(this.estados()).some((estado) => estado.status === 'error'),
  );

  /** Cuantos ciclos se descartaron por colgarse: 0 es lo sano. */
  get descartados(): number {
    return this.ciclosDescartados;
  }

  /** Estado de un panel en un stack. */
  panel(panel: PanelName, stack: Stack): PanelState {
    return this.estados()[clave(panel, stack)] ?? INICIAL(panel, stack);
  }

  /** Serie concreta de un panel, si existe. */
  serie(panel: PanelName, stack: Stack, label: string): MetricSeries | null {
    return this.panel(panel, stack).data?.series.find((serie) => serie.label === label) ?? null;
  }

  /** Arranca el refresco periodico. Idempotente. */
  start(): void {
    if (this.temporizador) {
      return;
    }
    void this.refreshAll();
    this.temporizador = setInterval(() => void this.refreshAll(), environment.metricsIntervalMs);
  }

  /** Para el refresco periodico (al destruir la app o al terminar un test). */
  stop(): void {
    if (this.temporizador) {
      clearInterval(this.temporizador);
      this.temporizador = null;
    }
  }

  /** Cambia el panel del modo comparativa y lo vuelve a pedir. */
  setComparisonPanel(panel: ComparablePanel): void {
    this.comparativaDe.set(panel);
    void this.refreshComparativa();
  }

  /** Refresco inmediato de todo (boton "refresh"). */
  async refreshAll(): Promise<void> {
    if (this.pidiendo) {
      // Si el ciclo anterior se quedo colgado mas de la cuenta, se le retira la vez: si no, un unico
      // cuelgue bloquea todos los sondeos siguientes y la pagina se queda muda para siempre.
      const transcurrido = Date.now() - (this.inicioCiclo ?? 0);
      if (this.inicioCiclo !== null && transcurrido > REQUEST_TIMEOUT_MS + 5000) {
        console.warn(
          `[aggora] el ciclo de paneles lleva ${transcurrido} ms colgado: se descarta y se empieza otro`,
        );
        this.pidiendo = false;
        this.ciclosDescartados += 1;
      } else {
        return;
      }
    }
    this.pidiendo = true;
    this.inicioCiclo = Date.now();
    try {
      const tareas: Promise<void>[] = [];
      for (const stack of STACKS) {
        for (const panel of PANELES_SIMPLES) {
          tareas.push(this.pedir(panel, stack));
        }
        tareas.push(this.pedirComparativa(stack, this.comparativaDe()));
      }
      await Promise.all(tareas);
    } finally {
      this.pidiendo = false;
      this.inicioCiclo = null;
    }
  }

  private async refreshComparativa(): Promise<void> {
    await Promise.all(STACKS.map((stack) => this.pedirComparativa(stack, this.comparativaDe())));
  }

  private async pedirComparativa(stack: Stack, de: ComparablePanel): Promise<void> {
    await this.pedir('comparativa', stack, de);
  }

  /** Una peticion. Un panel que falla no arrastra a los demas. */
  private async pedir(panel: PanelName, stack: Stack, de?: ComparablePanel): Promise<void> {
    const inicio = Date.now();
    const url = metricsUrl(this.endpoints[stack], panel, de);
    // Se apunta el arranque de la peticion: asi la UI puede distinguir "va lento" de "no hay nadie".
    this.escribir(panel, stack, { status: 'loading', requestedAt: inicio });
    // Traza de consola (F12): se ve si la peticion sale y si vuelve. Barata y util.
    console.info('[aggora] pidiendo', url);
    try {
      const crudo = await getJson(url);
      console.info('[aggora] respuesta OK', panel, stack, Date.now() - inicio, 'ms');
      const datos = parseMetricsResponse(crudo);
      const transcurrido = Date.now() - inicio;
      if (!datos) {
        this.escribir(panel, stack, {
          status: 'error',
          data: null,
          note: 'la respuesta no sigue la forma del contrato (panel, ts, stack, series)',
          warnings: [],
          fetchedAt: Date.now(),
          elapsedMs: transcurrido,
        });
        return;
      }
      this.escribir(panel, stack, {
        status: datos.series.length === 0 ? 'empty' : 'ok',
        data: datos,
        note: datos.nota ?? null,
        warnings: contractWarnings(datos),
        fetchedAt: Date.now(),
        elapsedMs: transcurrido,
      });
    } catch (error) {
      console.warn('[aggora] peticion FALLIDA', panel, stack, error);
      this.escribir(panel, stack, {
        status: 'error',
        data: null,
        note: describirErrorHttp(error, `panel "${panel}" (${stack})`),
        warnings: [],
        fetchedAt: Date.now(),
        elapsedMs: Date.now() - inicio,
      });
    }
  }

  private escribir(panel: PanelName, stack: Stack, cambio: Partial<PanelState>): void {
    this.estados.update((todos) => ({
      ...todos,
      [clave(panel, stack)]: { ...(todos[clave(panel, stack)] ?? INICIAL(panel, stack)), ...cambio },
    }));
  }
}

function clave(panel: PanelName, stack: Stack): string {
  return `${panel}:${stack}`;
}

/** Ultimo valor numerico de una serie de un panel, o `null`. Atajo para la UI. */
export function valorDe(estado: PanelState, label: string): number | null {
  const serie = estado.data?.series.find((candidata) => candidata.label === label);
  return serie ? lastValue(serie) : null;
}

/** Traza compartida de arranque, leible en `window.__aggoraTrace`. */
function trazaArranque(paso: string): void {
  const global = globalThis as { __aggoraTrace?: string[] };
  global.__aggoraTrace = global.__aggoraTrace ?? [];
  global.__aggoraTrace.push(`${Math.round(performance.now())} ms  ${paso}`);
}
