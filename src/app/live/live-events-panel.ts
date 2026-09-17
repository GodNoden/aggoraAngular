import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LiveState } from '../core/live.service';
import { EventFeed } from '../ui/event-feed';
import { formatAge, formatClock, formatInteger } from '../ui/format';
import { LineChart } from '../charts/line-chart';

/**
 * El latido en vivo: lo que llega por WebSocket.
 *
 * Tres cosas, por orden de "cuanto corre":
 *
 *  1. La tasa del gateway (ticks de entrada por segundo) en una grafica de ventana movil.
 *  2. El ultimo precio de cada simbolo, que es la foto por segundo. Un simbolo que deja de cotizar
 *     mantiene su ultimo precio; por eso se ensena tambien la antiguedad del tick (`age`), que es lo
 *     que delata a un simbolo parado.
 *  3. Alertas y posiciones, que son las unicas que viajan al momento.
 *
 * Aqui hay una cosa que el contrato deja claro y conviene repetir en pantalla: el WebSocket es un
 * fan-out, no un log. Si el navegador se pierde un segundo, se corrige con el siguiente snapshot;
 * esta pagina no reconstruye el pasado y no lo intenta.
 */
@Component({
  selector: 'app-live-events-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, EventFeed],
  template: `
    <div class="pulse-row">
      <div class="pulse">
        <div class="numbers">
          <div class="big">
            <span class="value">{{ formatInteger(ticksIn()) }}</span>
            <span class="unit">ticks/s in</span>
          </div>
          <div class="small">
            <span class="value">{{ formatInteger(ticksOut()) }}</span>
            <span class="unit">symbols out</span>
          </div>
        </div>
        <app-line-chart
          [values]="history()"
          color="#3ddc97"
          [height]="44"
          [ariaLabel]="'ticks per second from the live WebSocket window'"
        />
        <p class="hint">
          Snapshot every second. {{ snapshots() }} received so far, window of
          {{ history().length }} s.
          @if (lastTs(); as ultimo) {
            Last one at {{ clock(ultimo) }}.
          }
        </p>
      </div>
    </div>

    <section class="block">
      <header>
        <h4>Last tick per symbol ({{ symbols().length }})</h4>
        <span class="note">sorted by age: the stalest first</span>
      </header>
      @if (symbols().length === 0) {
        <p class="empty">No snapshot yet. The gateway sends one per second; if this stays empty, check the socket above.</p>
      } @else {
        <div class="symbols">
          @for (simbolo of symbols(); track simbolo.symbol) {
            <div class="symbol">
              <span class="name">{{ simbolo.symbol }}</span>
              <span class="price">{{ simbolo.price }}</span>
              <span class="meta">{{ simbolo.source }} · {{ simbolo.size }} · {{ age(simbolo.at) }}</span>
            </div>
          }
        </div>
      }
    </section>

    <section class="block">
      <header>
        <h4>Alerts ({{ live().alerts.length }})</h4>
        <span class="note">sent immediately, not once a second</span>
      </header>
      <app-event-feed [alerts]="live().alerts" />
    </section>

    <section class="block">
      <header>
        <h4>Positions ({{ live().positions.length }})</h4>
        <span class="note">money as text: Avro decimals, never floats</span>
      </header>
      @if (live().positions.length === 0) {
        <p class="empty">No position updates yet.</p>
      } @else {
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Symbol</th>
              <th class="num">Qty</th>
              <th class="num">Avg cost</th>
              <th class="num">Realized PnL</th>
              <th class="num">Exposure</th>
              <th>Margin</th>
            </tr>
          </thead>
          <tbody>
            @for (posicion of live().positions; track posicion.account + posicion.symbol) {
              <tr [class.breach]="posicion.marginBreach">
                <td>{{ posicion.account }}</td>
                <td>{{ posicion.symbol }}</td>
                <td class="num">{{ posicion.quantity }}</td>
                <td class="num">{{ posicion.averageCost }}</td>
                <td class="num">{{ posicion.realizedPnl }}</td>
                <td class="num">{{ posicion.exposure }}</td>
                <td>
                  @if (posicion.marginBreach) {
                    <span class="tag bad">BREACH</span>
                  } @else {
                    <span class="tag ok">ok</span>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </section>

    @if (parseError(); as error) {
      <p class="parse-error">
        A frame did not match the contract and was skipped, without taking the page down:
        <strong>{{ error.reason }}</strong>
        <code>{{ error.raw }}</code>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .pulse-row {
      margin-bottom: 10px;
    }
    .numbers {
      display: flex;
      align-items: baseline;
      gap: 14px;
    }
    .big .value {
      font-size: 26px;
      font-weight: 650;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .small .value {
      font-size: 15px;
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
    }
    .unit {
      font-size: 11px;
      color: var(--ink-faint);
      margin-left: 5px;
    }
    .hint {
      margin: 3px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
    }
    .block {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
    }
    .block header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 5px;
    }
    h4 {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ink-soft);
    }
    .note {
      font-size: 10.5px;
      color: var(--ink-faint);
    }
    .symbols {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 3px 10px;
      max-height: 190px;
      overflow-y: auto;
    }
    .symbol {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0 6px;
      padding: 3px 0;
      border-bottom: 1px solid var(--surface-2);
    }
    .symbol .name {
      font-size: 12px;
      color: var(--ink);
      font-weight: 600;
    }
    .symbol .price {
      font-size: 12px;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .symbol .meta {
      grid-column: 1 / -1;
      font-size: 10px;
      color: var(--ink-faint);
    }
    .empty {
      margin: 0;
      font-size: 12px;
      color: var(--ink-faint);
      font-style: italic;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11.5px;
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
      padding: 2px 4px;
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid var(--surface-2);
    }
    .num {
      text-align: right;
    }
    tr.breach td {
      color: var(--bad);
    }
    .tag {
      font-size: 10px;
      padding: 0 4px;
      border-radius: 3px;
    }
    .tag.ok {
      color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, transparent);
    }
    .tag.bad {
      color: var(--bad);
      background: color-mix(in srgb, var(--bad) 15%, transparent);
    }
    .parse-error {
      margin: 8px 0 0;
      font-size: 11.5px;
      color: var(--warn);
      line-height: 1.45;
      border-left: 2px solid var(--warn);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--warn) 8%, transparent);
      border-radius: 4px;
    }
    .parse-error code {
      display: block;
      font-family: var(--mono);
      font-size: 10px;
      color: var(--ink-faint);
      margin-top: 3px;
      word-break: break-all;
    }
  `,
})
export class LiveEventsPanel {
  readonly live = input.required<LiveState>();

  readonly history = computed(() => this.live().history.map((punto) => punto.ticksIn));
  readonly ticksIn = computed(() => this.history().at(-1) ?? null);
  readonly ticksOut = computed(() => this.live().history.at(-1)?.ticksOut ?? null);
  readonly snapshots = computed(() => this.live().counters['snapshot'] ?? 0);
  readonly lastTs = computed(() => {
    const ts = this.live().lastSnapshot?.ts;
    if (!ts) {
      return null;
    }
    const fecha = Date.parse(ts);
    return Number.isNaN(fecha) ? null : fecha;
  });

  /** Simbolos de la ultima foto, los mas viejos primero: un simbolo parado se ve enseguida. */
  readonly symbols = computed(() => {
    const simbolos = this.live().lastSnapshot?.symbols ?? {};
    return Object.entries(simbolos)
      .map(([symbol, tick]) => ({
        symbol,
        price: tick.price,
        currency: tick.currency,
        size: tick.size,
        source: tick.source,
        at: tick.at,
        atMs: Date.parse(tick.at) || 0,
      }))
      .sort((a, b) => a.atMs - b.atMs);
  });

  readonly parseError = computed(() => this.live().lastParseError);

  clock(valor: number): string {
    return formatClock(valor);
  }

  age(valor: string): string {
    return formatAge(Date.parse(valor) || null, Date.now());
  }

  protected readonly formatInteger = formatInteger;
}
