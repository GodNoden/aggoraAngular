import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { PanelState } from '../core/metrics.service';
import { SeriesHistoryService } from '../core/series-history.service';
import { SERIES_PALETTE } from '../core/panel-docs';
import { PanelName, Stack } from '../core/contract';
import { lastTimestamp, lastValue } from '../core/contract.parser';
import { formatInteger, formatNumber, shortLabel } from '../ui/format';
import { LineChart } from '../charts/line-chart';

/**
 * Lista de series con su mini-grafica de la ventana guardada.
 *
 * Se usa en `particiones`, `descartes` y `salud`, que devuelven decenas de series (una por
 * particion, por topic, por target). Cada fila: etiqueta, sparkline, valor actual.
 *
 * Si la ventana tiene un solo punto, la mini-grafica sale plana y se dice: un punto no es una
 * tendencia, y fingir lo contrario seria mentir con la forma.
 */
@Component({
  selector: 'app-series-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart],
  template: `
    <div class="head">
      <span class="count">{{ rows().length }} series</span>
      <span class="when">{{ when() }}</span>
    </div>
    <div class="rows">
      @for (row of rows(); track row.label) {
        <div class="row">
          <span class="label" [title]="row.label">{{ shorten(row.label) }}</span>
          <app-line-chart
            class="spark"
            [values]="row.history"
            [color]="row.color"
            [width]="110"
            [height]="20"
            [ariaLabel]="row.label + ' recent window'"
          />
          <span class="value" [attr.data-tone]="row.tone">{{ row.text }}</span>
        </div>
      }
    </div>
    @if (singlePoint()) {
      <p class="hint">
        Only one point per series so far. Prometheus answers with an instant value, so the history
        builds up as the page keeps polling: a flat mini-line here means "not enough points yet", not
        "nothing is happening".
      </p>
    }
    @if (hidden() > 0) {
      <p class="hint">
        {{ hidden() }} more series came back from the catalog and are not listed here to keep the
        panel readable. The count above is the honest total.
      </p>
    }
    <ng-content />
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: flex;
      justify-content: space-between;
      font-size: 10.5px;
      color: var(--ink-faint);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .rows {
      display: grid;
      gap: 1px;
      max-height: 230px;
      overflow-y: auto;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(88px, 1.2fr) 110px auto;
      align-items: center;
      gap: 8px;
      padding: 1px 0;
      font-size: 12px;
    }
    .label {
      color: var(--ink-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .spark {
      --chart-height: 20px;
    }
    .value {
      font-variant-numeric: tabular-nums;
      color: var(--ink);
      text-align: right;
      min-width: 58px;
      font-size: 11.5px;
    }
    .value[data-tone='bad'] {
      color: var(--bad);
    }
    .value[data-tone='warn'] {
      color: var(--warn);
    }
    .value[data-tone='muted'] {
      color: var(--ink-faint);
    }
    .hint {
      margin: 6px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class SeriesView {
  private readonly history = inject(SeriesHistoryService);

  readonly state = input.required<PanelState>();
  readonly panel = input.required<PanelName>();
  readonly stack = input.required<Stack>();
  /** Cuantas series se pintan como maximo (las demas se cuentan aparte). */
  readonly limit = input(14);
  /** Texto extra por etiqueta, para explicar series conocidas (DLT, ISR...). */
  readonly hints = input<Readonly<Record<string, string>>>({});

  readonly rows = computed(() => {
    const series = this.state().data?.series ?? [];
    return series.slice(0, this.limit()).map((serie, indice) => {
      const valor = lastValue(serie);
      return {
        label: serie.label,
        history: [...this.history.values(this.panel(), this.stack(), serie.label)],
        color: SERIES_PALETTE[indice % SERIES_PALETTE.length],
        text: valor === null ? '--' : Number.isInteger(valor) ? formatInteger(valor) : formatNumber(valor),
        tone: valor === null ? 'muted' : valor > 0 && this.hints()[serie.label] ? 'bad' : 'ok',
      };
    });
  });

  /** Cuantas series quedan fuera de la lista. */
  readonly hidden = computed(() => Math.max(0, (this.state().data?.series.length ?? 0) - this.limit()));

  readonly when = computed(() => {
    const series = this.state().data?.series ?? [];
    const instante = series.length > 0 ? lastTimestamp(series[0]) : null;
    if (instante === null) {
      return '';
    }
    return `snapshot ${new Date(instante * 1000).toLocaleTimeString('en-GB', { hour12: false })}`;
  });

  readonly singlePoint = computed(() =>
    (this.state().data?.series ?? []).some((serie) => serie.points.length === 1),
  );

  shorten(label: string): string {
    return shortLabel(label, 30);
  }
}
