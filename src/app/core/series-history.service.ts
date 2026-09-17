/**
 * Ventana movil de las series de metricas.
 *
 * El WebSocket ya da un punto por segundo, pero los paneles de Prometheus se piden cada 5-10 s y
 * cada serie trae **un unico punto** (consulta instantanea). Para poder dibujar una linea hace falta
 * guardar la ventana reciente: eso es este servicio, y solo eso. No es una base de datos ni un
 * store: se queda con los ultimos N puntos por serie y los tira.
 *
 * Vive en memoria a proposito. El contrato dice que la verdad esta en Prometheus y que esta pagina
 * no puede reconstruir el pasado: si se recarga, la ventana empieza de cero y es correcto.
 */

import { Injectable, Signal, inject, signal } from '@angular/core';
import { effect } from '@angular/core';
import { MetricsService } from './metrics.service';
import { PANELS, PanelName, Stack, STACKS } from './contract';
import { lastValue } from './contract.parser';

/** Cuantos puntos se guardan por serie (a 5 s por punto, 60 puntos son 5 minutos). */
const MAX_PUNTOS = 60;

@Injectable({ providedIn: 'root' })
export class SeriesHistoryService {
  private readonly metrics = inject(MetricsService);

  /** [panel:stack:label] -> valores, en orden temporal. */
  private readonly historial = signal<Readonly<Record<string, readonly number[]>>>({});

  /** Errores de parseo del WebSocket que ya se han contado, para no repetir el aviso. */
  readonly history: Signal<Readonly<Record<string, readonly number[]>>> = this.historial.asReadonly();

  constructor() {
    // Un unico efecto que mira los paneles: cada vez que llega un refresco, se apunta el valor.
    effect(() => {
      const paneles = this.metrics.panels();
      const anadidos: Record<string, readonly number[]> = {};
      for (const panel of PANELS) {
        for (const stack of STACKS) {
          const estado = paneles[`${panel}:${stack}`];
          const datos = estado?.data;
          if (!datos || !estado?.fetchedAt) {
            continue;
          }
          for (const serie of datos.series) {
            const valor = lastValue(serie);
            if (valor === null) {
              continue;
            }
            const clave = claveDe(panel, stack, serie.label);
            const previos = anadidos[clave] ?? this.historial()[clave] ?? [];
            const ultimo = previos.at(-1);
            // Solo se apunta cuando el valor cambia o cuando es el primero: asi un refresco que
            // devuelve el mismo dato no llena la ventana de puntos repetidos.
            anadidos[clave] = ultimo === valor ? previos : [...previos, valor].slice(-MAX_PUNTOS);
          }
        }
      }
      if (Object.keys(anadidos).length > 0) {
        this.historial.update((actual) => ({ ...actual, ...anadidos }));
      }
    });
  }

  /** Valores guardados de una serie concreta. */
  values(panel: PanelName, stack: Stack, label: string): readonly number[] {
    return this.historial()[claveDe(panel, stack, label)] ?? [];
  }
}

function claveDe(panel: PanelName, stack: Stack, label: string): string {
  return `${panel}:${stack}:${label}`;
}
