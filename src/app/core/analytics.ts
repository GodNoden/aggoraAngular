/**
 * La consulta interactiva: la unica cosa de esta pagina que pide el usuario a proposito.
 *
 * Los demas paneles son Prometheus (series que ya existen). Este no: `GET /analytics` pregunta al
 * **state store** del motor de streams por las ventanas que ha calculado el, con su VWAP y su
 * volatilidad. Es la diferencia entre "lo que se ha publicado" y "lo que el motor ha calculado", y
 * por eso merece un panel propio.
 */

import { Injectable, signal } from '@angular/core';
import { analyticsUrl, getText, parseJson, parseWindows } from './api';
import { Stack, Window } from './types';

@Injectable({ providedIn: 'root' })
export class Analytics {
  private readonly estado = signal<{
    readonly status: 'inicial' | 'pidiendo' | 'ok' | 'vacio' | 'error';
    readonly windows: readonly Window[];
    readonly note: string | null;
    readonly symbol: string;
    readonly minutes: number;
    readonly ms: number | null;
    /** A que stack se le pregunto, para poder decir en pantalla si la respuesta es de este. */
    readonly stack: Stack | null;
  }>({
    status: 'inicial',
    windows: [],
    note: null,
    symbol: 'EUR/USD',
    minutes: 3,
    ms: null,
    stack: null,
  });

  readonly state = this.estado.asReadonly();

  /** Pregunta por las ventanas de un simbolo. Un fallo se cuenta, no se lanza. */
  async query(stack: Stack, symbol: string, minutes: number): Promise<void> {
    const limpio = symbol.trim() || 'EUR/USD';
    this.estado.update((actual) => ({
      ...actual,
      status: 'pidiendo',
      symbol: limpio,
      minutes,
      note: null,
      stack,
    }));
    const url = analyticsUrl(stack, limpio, minutes);
    const inicio = Date.now();
    try {
      const crudo = parseJson(await getText(url));
      const windows = parseWindows(crudo);
      this.estado.update((actual) => ({
        ...actual,
        status: windows.length > 0 ? 'ok' : 'vacio',
        windows,
        note:
          windows.length === 0
            ? 'el state store no tiene ventanas para ese simbolo y esa ventana temporal'
            : null,
        ms: Date.now() - inicio,
      }));
    } catch (error) {
      this.estado.update((actual) => ({
        ...actual,
        status: 'error',
        windows: [],
        note: error instanceof Error ? error.message : String(error),
        ms: Date.now() - inicio,
      }));
    }
  }
}
