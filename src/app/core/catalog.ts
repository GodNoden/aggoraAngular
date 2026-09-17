/**
 * El catalogo de metricas: siete nombres cerrados, ni uno mas.
 *
 * `GET <gateway>/metrics?panel=<nombre>` es la unica entrada: **no hay PromQL libre**, y eso es una
 * decision del backend, no una limitacion de esta pagina. Aqui no se construye ninguna consulta.
 *
 * Cada panel tiene **un solo punto** por serie (consulta instantanea), asi que no hay historia que
 * pintar. Para que las graficas digan algo, esta pagina guarda su propia ventana corta de los
 * valores que va viendo: eso es `historial`, y es lo unico que se inventa la app (y no es un dato,
 * es memoria de lo que ya le dieron).
 */

import { Injectable, computed, signal } from '@angular/core';
import { catalogUrl, getText, parseJson, parsePanel } from './api';
import { PanelData, STACKS, Stack, value } from './types';

/** Cada cuanto se piden los paneles (ms). Cada 4 s: es de buena educacion con Prometheus. */
export const POLL_MS = 4000;

/** Cuantos valores se guardan por serie para las mini-graficas. */
const HISTORIA_MAX = 60;

/** Los paneles del catalogo, en el orden en que se leen: del latido a la letra pequena. */
export const PANELS = [
  'pulso',
  'lag',
  'particiones',
  'descartes',
  'salud',
  'transacciones',
] as const;

export type PanelName = (typeof PANELS)[number];

/** Paneles que `comparativa` sabe comparar. */
export const COMPARABLES = ['pulso', 'lag', 'particiones', 'descartes'] as const;

/** Como esta un panel en un stack: pedido, con datos, vacio a proposito o roto. */
export type Status = 'pidiendo' | 'ok' | 'vacio' | 'error';

export interface Entry {
  readonly status: Status;
  readonly data: PanelData | null;
  /** La `nota` del backend (por que no hay datos) o el error de red, con la URL. */
  readonly note: string | null;
  readonly ms: number | null;
  readonly at: number | null;
}

const VACIO: Entry = { status: 'pidiendo', data: null, note: null, ms: null, at: null };

/** Clave de un panel: `panel:stack`. */
type Key = string;
const key = (panel: string, stack: Stack): Key => `${panel}:${stack}`;

@Injectable({ providedIn: 'root' })
export class Catalog {
  private readonly entries = signal<Readonly<Record<Key, Entry>>>({});
  /** Ventana corta por serie: `panel:stack:label` -> valores vistos. */
  private readonly historia = signal<Readonly<Record<string, readonly number[]>>>({});

  private temporizador: ReturnType<typeof setInterval> | null = null;

  /** Estado de cada panel en cada stack. */
  readonly state = this.entries.asReadonly();

  /** El panel que se compara en el modo lado a lado. */
  readonly comparado = signal<string>('pulso');

  /** Cuantas veces se ha completado un ciclo entero de sondeo. */
  readonly ciclos = signal(0);

  /** Alguna peticion fallo: la pagina lo dice en la cabecera. */
  readonly hayErrores = computed(() =>
    Object.values(this.entries()).some((entrada) => entrada.status === 'error'),
  );

  /** Cuantos paneles estan respondiendo. */
  readonly respondiendo = computed(
    () => Object.values(this.entries()).filter((entrada) => entrada.status === 'ok').length,
  );

  /** Ultima respuesta recibida, para el "hace N s" de la cabecera. */
  readonly ultima = computed(() => {
    const tiempos = Object.values(this.entries())
      .map((entrada) => entrada.at)
      .filter((valor): valor is number => valor !== null);
    return tiempos.length > 0 ? Math.max(...tiempos) : null;
  });

  /** Estado de un panel. */
  entry(panel: string, stack: Stack): Entry {
    return this.entries()[key(panel, stack)] ?? VACIO;
  }

  /** Ventana guardada de una serie. */
  serie(panel: string, stack: Stack, label: string): readonly number[] {
    return this.historia()[`${panel}:${stack}:${label}`] ?? [];
  }

  /** Arranca el sondeo. Idempotente. */
  start(): void {
    if (this.temporizador) {
      return;
    }
    void this.refresh();
    this.temporizador = setInterval(() => void this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.temporizador) {
      clearInterval(this.temporizador);
      this.temporizador = null;
    }
  }

  /** Pide todo el catalogo, **de uno en uno**. */
  async refresh(): Promise<void> {
    for (const stack of STACKS) {
      for (const panel of PANELS) {
        await this.pedir(panel, stack);
      }
      await this.pedirComparativa(stack);
    }
    this.ciclos.update((valor) => valor + 1);
  }

  async pedirComparativa(stack: Stack): Promise<void> {
    await this.pedir('comparativa', stack, this.comparado());
  }

  /**
   * Una peticion.
   *
   * En serie y no en paralelo a proposito: se lanzaban las catorce a la vez y el navegador dejaba de
   * procesar las respuestas. Una detras de otra llena la pantalla igual de rapido para quien mira.
   */
  private async pedir(panel: string, stack: Stack, de?: string): Promise<void> {
    const url = catalogUrl(stack, panel, de);
    const inicio = Date.now();
    this.write(key(panel, stack), { status: 'pidiendo', note: null });
    try {
      const crudo = parseJson(await getText(url));
      const datos = parsePanel(crudo, panel, stack);
      if (!datos) {
        this.write(key(panel, stack), {
          status: 'error',
          data: null,
          note: `la respuesta no sigue la forma del contrato (panel, ts, stack, series): ${url}`,
          ms: Date.now() - inicio,
          at: Date.now(),
        });
        return;
      }
      this.write(key(panel, stack), {
        status: datos.series.length === 0 ? 'vacio' : 'ok',
        data: datos,
        // La nota del backend se guarda tal cual: es la explicacion del hueco.
        note: datos.nota ?? null,
        ms: Date.now() - inicio,
        at: Date.now(),
      });
      this.apuntar(datos);
    } catch (error) {
      this.write(key(panel, stack), {
        status: 'error',
        data: null,
        note: error instanceof Error ? error.message : String(error),
        ms: Date.now() - inicio,
        at: Date.now(),
      });
    }
  }

  /** Guarda el ultimo valor de cada serie en su ventana corta. */
  private apuntar(datos: PanelData): void {
    const cambios: Record<string, readonly number[]> = {};
    for (const series of datos.series) {
      const actual = value(series);
      if (actual === null) {
        continue;
      }
      const clave = `${datos.panel}:${datos.stack}:${series.label}`;
      const previos = cambios[clave] ?? this.historia()[clave] ?? [];
      // Solo cuando cambia: un refresco que repite el mismo dato no llena la ventana.
      if (previos[previos.length - 1] === actual) {
        continue;
      }
      cambios[clave] = [...previos, actual].slice(-HISTORIA_MAX);
    }
    if (Object.keys(cambios).length > 0) {
      this.historia.update((actual) => ({ ...actual, ...cambios }));
    }
  }

  private write(clave: Key, cambio: Partial<Entry>): void {
    this.entries.update((todas) => ({
      ...todas,
      [clave]: { ...(todas[clave] ?? VACIO), ...cambio },
    }));
  }
}
