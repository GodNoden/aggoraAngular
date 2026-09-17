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
 *
 * ---------------------------------------------------------------------------------------------
 * **La trampa que costo este bug, escrita para que no se repita.**
 *
 * Este servicio tuvo durante mucho tiempo un `effect()` que leia `historial()` para saber el ultimo
 * valor guardado de cada serie y luego escribia en `historial()`. Un efecto que lee y escribe la
 * misma senal se alimenta a si mismo: la escritura lo vuelve a programar, y otra vez, y otra. No
 * salta el error de "bucle infinito" de Angular porque el efecto se reprograma de forma asincrona y
 * cada vuelta termina; simplemente **nunca deja el hilo principal libre**. El sintoma era el peor
 * posible para diagnosticar: la cabecera se pintaba y los paneles se quedaban en `loading` para
 * siempre, con el renderer tan ocupado que no atendia ni las ordenes del depurador
 * (`Runtime.evaluate` sin responder), mientras `curl`, el catalogo y el WebSocket funcionaban.
 *
 * La regla, a partir de ahora: **el efecto lee `panels()`, que es el disparador, y para consultar su
 * propio estado usa el mapa normal `ultimos`, que no es una senal**. La unica dependencia reactiva
 * del efecto es la que debe dispararlo.
 * ---------------------------------------------------------------------------------------------
 */

import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import { MetricsService } from './metrics.service';
import { PANELS, PanelName, Stack, STACKS } from './contract';
import { lastValue } from './contract.parser';

/** Cuantos puntos se guardan por serie (a 5 s por punto, 60 puntos son 5 minutos). */
const MAX_PUNTOS = 60;

@Injectable({ providedIn: 'root' })
export class SeriesHistoryService {
  private readonly metrics = inject(MetricsService);

  /** [panel:stack:label] -> valores, en orden temporal. Lo que leen las graficas. */
  private readonly historial = signal<Readonly<Record<string, readonly number[]>>>({});

  /**
   * El mismo contenido, pero **sin ser una senal**.
   *
   * Es la fuente que consulta el efecto para saber el ultimo valor de cada serie. Tiene que ser un
   * mapa normal: leer `historial()` dentro del efecto lo ataria a su propia escritura y lo
   * convertiria en un bucle (ver la nota de arriba).
   */
  private readonly ultimos: Record<string, readonly number[]> = {};

  /** Ventana guardada, para las graficas. */
  readonly history: Signal<Readonly<Record<string, readonly number[]>>> = this.historial.asReadonly();

  /** Cuantas series tienen ya ventana guardada. Util para el diagnostico y para los tests. */
  readonly seriesConHistoria = computed(() => Object.keys(this.historial()).length);

  /**
   * Cuantas veces ha corrido el efecto.
   *
   * No es un adorno: es la senal de alarma del fallo que tuvo este servicio. Si el efecto lee y
   * escribe la misma senal, cada vuelta lo reprograma y este numero sube sin parar mientras el hilo
   * principal se queda sin turno. Que se quede quieto cuando los paneles no cambian es la prueba de
   * que el efecto no se alimenta de si mismo.
   */
  readonly vueltasDelEfecto = signal(0);

  constructor() {
    // Un unico efecto, con **una sola dependencia reactiva**: `panels()`.
    effect(() => {
      this.vueltasDelEfecto.update((valor) => valor + 1);
      const paneles = this.metrics.panels();
      // A partir de aqui se trabaja sobre el mapa normal y sobre los datos que acaban de llegar.
      const anadidos: Record<string, readonly number[]> = {};
      for (const panel of PANELS) {
        for (const stack of STACKS) {
          const estado = paneles[clavePanel(panel, stack)];
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
            const previos = anadidos[clave] ?? this.ultimos[clave] ?? [];
            const ultimo = previos.at(-1);
            // Solo se apunta cuando el valor cambia o cuando es el primero: asi un refresco que
            // devuelve el mismo dato no llena la ventana de puntos repetidos. Ademas, en la segunda
            // vuelta del efecto no hay nada que escribir y el bucle no llega a existir.
            if (ultimo === valor) {
              continue;
            }
            const ventana = [...previos, valor].slice(-MAX_PUNTOS);
            this.ultimos[clave] = ventana;
            anadidos[clave] = ventana;
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

function clavePanel(panel: PanelName, stack: Stack): string {
  return `${panel}:${stack}`;
}

function claveDe(panel: PanelName, stack: Stack, label: string): string {
  return `${panel}:${stack}:${label}`;
}
