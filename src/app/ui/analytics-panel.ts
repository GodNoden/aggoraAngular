import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AnalyticsService } from '../core/analytics.service';
import { environment } from '../../environments/environment';
import { formatClock, formatInteger, formatNumber } from './format';

/**
 * La consulta interactiva al estado: `GET /analytics?symbol=&minutes=`.
 *
 * Es el panel del *state store*: la ventana calculada en vivo (VWAP, volatilidad) que publica
 * `analytics-streams`. La diferencia con el resto de la pagina es que **esto si lo dispara el
 * usuario**: se pide al pulsar Query y no en bucle, porque es una consulta al motor y no un panel de
 * Prometheus.
 *
 * Es tambien el panel que delata la leccion 5: con el motor muerto el endpoint devuelve 503 y aqui
 * se ve el error explicado, no una grafica vacia.
 */
@Component({
  selector: 'app-analytics-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form class="query" (ngSubmit)="buscar()">
      <label>
        <span>Symbol</span>
        <input
          name="symbol"
          [ngModel]="symbol()"
          (ngModelChange)="symbol.set($event)"
          list="simbolos-conocidos"
          placeholder="EUR/USD"
          autocomplete="off"
        />
        <datalist id="simbolos-conocidos">
          @for (sugerencia of suggestions(); track sugerencia) {
            <option [value]="sugerencia"></option>
          }
        </datalist>
      </label>
      <label class="minutes">
        <span>Minutes</span>
        <input
          name="minutes"
          type="number"
          min="1"
          max="60"
          [ngModel]="minutes()"
          (ngModelChange)="minutes.set($event)"
        />
      </label>
      <button type="submit" [disabled]="service.analytics().status === 'loading'">
        {{ service.analytics().status === 'loading' ? 'Querying...' : 'Query' }}
      </button>
    </form>

    <p class="origin">
      GET {{ endpoint() }} · only Spring publishes analytics-streams in this environment
    </p>

    @if (service.analytics().status === 'error') {
      <p class="error">
        {{ service.analytics().note }}
      </p>
    } @else if (service.analytics().status === 'idle') {
      <p class="idle">
        Nothing queried yet. Press Query to read the live window for a symbol.
      </p>
    } @else if (service.analytics().status === 'empty') {
      <p class="idle">{{ service.analytics().note }}</p>
    } @else if (service.analytics().status === 'ok') {
      <table>
        <thead>
          <tr>
            <th>Window</th>
            <th class="num">Ticks</th>
            <th class="num">Volume</th>
            <th class="num">VWAP</th>
            <th class="num">MA</th>
            <th class="num">Volatility</th>
            <th class="num">Last</th>
          </tr>
        </thead>
        <tbody>
          @for (ventana of service.analytics().windows; track ventana.windowStart + ventana.windowEnd) {
            <tr>
              <td class="window">
                <span class="kind">{{ ventana.windowKind }}</span>
                {{ clock(ventana.windowStart) }} &#8594; {{ clock(ventana.windowEnd) }}
              </td>
              <td class="num">{{ formatInteger(ventana.ticks) }}</td>
              <td class="num">{{ formatInteger(ventana.volume) }}</td>
              <td class="num">{{ formatNumber(ventana.vwap) }}</td>
              <td class="num">{{ formatNumber(ventana.movingAverage) }}</td>
              <td class="num">{{ formatNumber(ventana.volatility) }}</td>
              <td class="num">{{ formatNumber(ventana.lastPrice) }}</td>
            </tr>
          }
        </tbody>
      </table>
      <p class="caption">
        VWAP and volatility are computed by the stream, not by this page: the browser only asks and
        prints. A tumbling window that stops advancing while the clock moves is the signature of a
        dead engine (lesson 5).
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .query {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 10.5px;
      color: var(--ink-faint);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    label.minutes input {
      width: 68px;
    }
    input {
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 5px;
      color: var(--ink);
      font-size: 12.5px;
      padding: 5px 7px;
      font-family: inherit;
      min-width: 120px;
    }
    input:focus {
      outline: 1px solid var(--info);
      border-color: var(--info);
    }
    button {
      background: color-mix(in srgb, var(--info) 20%, var(--surface-2));
      border: 1px solid color-mix(in srgb, var(--info) 45%, var(--line));
      color: var(--ink);
      border-radius: 5px;
      padding: 6px 14px;
      font-size: 12.5px;
      font-family: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: progress;
    }
    .origin {
      margin: 6px 0 0;
      font-size: 10.5px;
      font-family: var(--mono);
      color: var(--ink-faint);
      word-break: break-all;
    }
    .idle {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--ink-faint);
      font-style: italic;
    }
    .error {
      margin: 8px 0 0;
      font-size: 11.5px;
      color: var(--bad);
      line-height: 1.45;
      border-left: 2px solid var(--bad);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--bad) 8%, transparent);
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11.5px;
      margin-top: 8px;
    }
    th {
      text-align: left;
      font-weight: 600;
      color: var(--ink-faint);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 4px;
      border-bottom: 1px solid var(--line);
    }
    td {
      padding: 3px 4px;
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid var(--surface-2);
    }
    .num {
      text-align: right;
    }
    .window {
      white-space: nowrap;
    }
    .kind {
      font-size: 9.5px;
      color: var(--ink-faint);
      border: 1px solid var(--line);
      border-radius: 3px;
      padding: 0 3px;
      margin-right: 4px;
    }
    .caption {
      margin: 7px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class AnalyticsPanel {
  protected readonly service = inject(AnalyticsService);

  readonly symbol = signal(environment.defaultAnalyticsSymbol);
  readonly minutes = signal(environment.defaultAnalyticsMinutes);

  readonly endpoint = computed(() => {
    const base = environment.spring.analytics || location.origin;
    return `${base}/analytics?symbol=${this.symbol()}&minutes=${this.minutes()}`;
  });

  /** Sugerencias: los simbolos del panel Lag y los del baseline del proyecto. */
  readonly suggestions = computed(() => ['EUR/USD', 'XAU/USD', 'AAPL', 'ASML', 'ASML.AMS', 'OR', 'MC', 'AIR']);

  buscar(): void {
    void this.service.query(this.symbol(), Number(this.minutes()) || environment.defaultAnalyticsMinutes);
  }

  clock(valor: string): string {
    return formatClock(valor);
  }

  protected readonly formatInteger = formatInteger;
  protected readonly formatNumber = formatNumber;
}
