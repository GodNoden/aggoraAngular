/**
 * Servicio de la consulta interactiva al estado (`GET /analytics?symbol=&minutes=`).
 *
 * Es el panel del *state store*: la ventana calculada en vivo (VWAP, volatilidad) que publica
 * `analytics-streams`. A diferencia de los paneles de metricas, esta consulta **si** la dispara el
 * usuario, y por eso se pide al pulsar "Query" y no en bucle.
 *
 * Ojo con la forma real (comprobada contra el backend): la respuesta es una **lista** de ventanas,
 * una por ventana temporal, y no un objeto. El contrato documenta la URL pero no esta forma; aqui
 * se acepta la lista y, por si acaso, tambien un objeto con `windows`.
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, Signal, inject, signal } from '@angular/core';
import { TimeoutError, firstValueFrom, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { analyticsUrl } from '../core/urls';
import { REQUEST_TIMEOUT_MS } from './metrics.service';

/** Una ventana calculada de un simbolo. */
export interface AnalyticsWindow {
  readonly symbol: string;
  readonly currency: string;
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

export type AnalyticsStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly http = inject(HttpClient);

  private readonly estado = signal<{
    status: AnalyticsStatus;
    windows: readonly AnalyticsWindow[];
    note: string | null;
    symbol: string;
    minutes: number;
    fetchedAt: number | null;
  }>({
    status: 'idle',
    windows: [],
    note: null,
    symbol: environment.defaultAnalyticsSymbol,
    minutes: environment.defaultAnalyticsMinutes,
    fetchedAt: null,
  });

  readonly analytics = this.estado.asReadonly();

  /** Pide las ventanas de un simbolo. Un fallo se cuenta, no se lanza. */
  async query(symbol: string, minutes: number): Promise<void> {
    const limpio = symbol.trim() || environment.defaultAnalyticsSymbol;
    this.estado.update((actual) => ({
      ...actual,
      status: 'loading',
      symbol: limpio,
      minutes,
      note: null,
    }));
    const url = analyticsUrl(environment.spring, limpio, minutes);
    try {
      const crudo = await firstValueFrom(
        this.http.get<unknown>(url).pipe(timeout(REQUEST_TIMEOUT_MS)),
      );
      const ventanas = parseAnalytics(crudo);
      this.estado.update((actual) => ({
        ...actual,
        status: ventanas.length > 0 ? 'ok' : 'empty',
        windows: ventanas,
        note: ventanas.length === 0 ? 'el state store no tiene ventanas para ese simbolo y esa ventana temporal' : null,
        fetchedAt: Date.now(),
      }));
    } catch (error) {
      this.estado.update((actual) => ({
        ...actual,
        status: 'error',
        windows: [],
        note: describirError(error, limpio, url),
        fetchedAt: Date.now(),
      }));
    }
  }
}

/** Acepta la lista real y, por tolerancia, un objeto `{windows: [...]}`. */
export function parseAnalytics(crudo: unknown): readonly AnalyticsWindow[] {
  const lista = Array.isArray(crudo)
    ? crudo
    : crudo && typeof crudo === 'object' && Array.isArray((crudo as { windows?: unknown }).windows)
      ? ((crudo as { windows: unknown[] }).windows)
      : [];
  const ventanas: AnalyticsWindow[] = [];
  for (const bruto of lista) {
    if (typeof bruto !== 'object' || bruto === null) {
      continue;
    }
    const datos = bruto as Record<string, unknown>;
    if (typeof datos['symbol'] !== 'string') {
      continue;
    }
    ventanas.push({
      symbol: datos['symbol'],
      currency: textoDe(datos['currency']),
      windowKind: textoDe(datos['windowKind']),
      windowStart: textoDe(datos['windowStart']),
      windowEnd: textoDe(datos['windowEnd']),
      ticks: numeroDe(datos['ticks']),
      volume: numeroDe(datos['volume']),
      vwap: numeroDe(datos['vwap']),
      movingAverage: numeroDe(datos['movingAverage']),
      volatility: numeroDe(datos['volatility']),
      lastPrice: numeroDe(datos['lastPrice']),
    });
  }
  return ventanas;
}

function textoDe(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

function numeroDe(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

function describirError(error: unknown, symbol: string, url: string): string {
  if (error instanceof TimeoutError) {
    return `no hubo respuesta en ${REQUEST_TIMEOUT_MS / 1000} s: ${url}`;
  }
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return `no hay respuesta de analytics (${environment.spring.analytics}): el servicio no esta levantado o CORS lo bloquea. Recuerda que la leccion 5 lo deja en 503 a proposito`;
    }
    return `HTTP ${error.status} al pedir las ventanas de ${symbol}`;
  }
  return `error inesperado en ${url} (ventanas de ${symbol}): ${String(error)}`;
}
