import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LiveState } from '../core/live.service';
import { PanelState } from '../core/metrics.service';
import { SERIES_PALETTE } from '../core/panel-docs';
import { formatInteger } from '../ui/format';
import { LineChart } from '../charts/line-chart';

/**
 * Panel `pulso`: el mercado entrando y saliendo.
 *
 * Dos fuentes a proposito, y se ven distintas:
 *
 *  - **WebSocket** (arriba): los ticks que el gateway resume cada segundo. Es lo que la pagina ve
 *    de verdad, en vivo, sin pedir nada.
 *  - **Prometheus** (abajo): las tasas de `rate(...[1m])` del catalogo. Va mas suave porque es una
 *    media de un minuto, y por eso se pide cada 5-10 s.
 *
 * Ensenar las dos juntas es la leccion: si divergen, o el gateway esta perdiendo resumenes, o
 * Prometheus ve algo que el WebSocket no.
 */
@Component({
  selector: 'app-pulse-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart],
  template: `
    <div class="pair">
      <div class="series">
        <app-line-chart
          [values]="ticksIn()"
          color="#3ddc97"
          [ariaLabel]="'ticks per second entering the raw topic, live from the WebSocket'"
        />
        <div class="legend">
          <span class="swatch in"></span>
          <span class="name">ticks in (WebSocket, 1 s)</span>
          <span class="value">{{ formatInteger(lastIn()) }}</span>
        </div>
      </div>
      <div class="series">
        <app-line-chart
          [values]="ticksOut()"
          color="#ffb454"
          [ariaLabel]="'symbols per snapshot coming out of the canonical topics, live from the WebSocket'"
        />
        <div class="legend">
          <span class="swatch out"></span>
          <span class="name">symbols out (WebSocket, 1 s)</span>
          <span class="value">{{ formatInteger(lastOut()) }}</span>
        </div>
      </div>
    </div>

    <div class="rates">
      @if (rates().length > 0) {
        @for (rate of rates(); track rate.label) {
          <span class="rate">
            <span class="dot" [style.background]="rate.color"></span>
            {{ rate.label }}
            <strong>{{ rate.text }}</strong>
          </span>
        }
      } @else {
        <span class="waiting">
          waiting for the metrics catalog: the rates per second arrive with the first successful poll
        </span>
      }
    </div>

    <p class="saved">
      Per second the gateway collapses {{ formatInteger(lastIn()) }} ticks into
      {{ formatInteger(lastOut()) }} values, one per symbol. Positions and alerts are the only things
      that still travel one by one.
    </p>
  `,
  styles: `
    :host {
      display: block;
    }
    .pair {
      display: grid;
      gap: 6px;
    }
    .legend {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--ink-soft);
      margin-top: -4px;
    }
    .swatch {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      display: inline-block;
    }
    .swatch.in {
      background: #3ddc97;
    }
    .swatch.out {
      background: #ffb454;
    }
    .legend .value {
      font-variant-numeric: tabular-nums;
      color: var(--ink);
      font-weight: 600;
    }
    .rates {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed var(--line);
    }
    .rate {
      font-size: 11.5px;
      color: var(--ink-soft);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .rate strong {
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
    }
    .waiting {
      font-size: 11.5px;
      color: var(--ink-faint);
      font-style: italic;
    }
    .saved {
      margin: 8px 0 0;
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class PulsePanel {
  /** Estado en vivo del stack que se esta mirando. */
  readonly live = input.required<LiveState>();
  /** Estado del panel de metricas del mismo stack. */
  readonly state = input.required<PanelState>();

  readonly ticksIn = computed(() => this.live().history.map((punto) => punto.ticksIn));
  readonly ticksOut = computed(() => this.live().history.map((punto) => punto.ticksOut));
  readonly lastIn = computed(() => this.ticksIn().at(-1) ?? null);
  readonly lastOut = computed(() => this.ticksOut().at(-1) ?? null);

  readonly rates = computed(() =>
    (this.state().data?.series ?? []).map((serie, indice) => {
      const ultimo = serie.points.at(-1);
      return {
        label: serie.label,
        color: SERIES_PALETTE[indice % SERIES_PALETTE.length],
        text: ultimo ? `${ultimo[1].toFixed(1)}/s` : '--',
      };
    }),
  );

  protected readonly formatInteger = formatInteger;
}
