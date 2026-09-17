import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatInteger, formatNumber, shortLabel, MetricRow } from './format';

/**
 * Tabla compacta de metricas: etiqueta, barra proporcional y valor.
 *
 * Se usa en los paneles con muchas series (particiones, descartes, salud). Muestra **todas** las
 * series que manda el backend y, si no hay ninguna, dice que no hay dato en vez de pintar una
 * grafica vacia.
 */
@Component({
  selector: 'app-metric-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rows().length === 0) {
      <p class="no-data">{{ emptyText() }}</p>
    } @else {
      <div class="table" [class.compact]="compact()">
        @for (row of rows(); track row.label) {
          <div class="row" [attr.data-tone]="row.tone ?? 'muted'">
            <span class="label" [title]="row.label">{{ shorten(row.label) }}</span>
            <span class="bar">
              <span
                class="fill"
                [style.width.%]="barWidth(row.value)"
                [style.background]="row.color"
              ></span>
            </span>
            <span class="value" [class.zero]="row.value === 0">{{ format(row) }}</span>
          </div>
          @if (row.hint) {
            <p class="hint">{{ row.hint }}</p>
          }
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .table {
      display: grid;
      gap: 2px;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(96px, 1.4fr) minmax(40px, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
      font-size: 12.5px;
    }
    .compact .row {
      padding: 1px 0;
      font-size: 12px;
    }
    .label {
      color: var(--ink-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar {
      background: var(--bar-track);
      border-radius: 3px;
      height: 6px;
      overflow: hidden;
    }
    .fill {
      display: block;
      height: 100%;
      border-radius: 3px;
      min-width: 0;
      transition: width 320ms ease;
    }
    .value {
      font-variant-numeric: tabular-nums;
      color: var(--ink);
      text-align: right;
      min-width: 62px;
    }
    .value.zero {
      color: var(--ink-faint);
    }
    .row[data-tone='ok'] .value {
      color: var(--ok);
    }
    .row[data-tone='warn'] .value {
      color: var(--warn);
    }
    .row[data-tone='bad'] .value {
      color: var(--bad);
    }
    .hint {
      margin: 0 0 6px 0;
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.35;
    }
    .no-data {
      margin: 0;
      font-size: 12.5px;
      color: var(--ink-faint);
      font-style: italic;
    }
  `,
})
export class MetricList {
  readonly rows = input<readonly MetricRow[]>([]);
  readonly emptyText = input('no data');
  readonly compact = input(false);

  /** Las barras son relativas al mayor valor absoluto de la lista. */
  private readonly maximo = computed(() =>
    Math.max(1e-9, ...this.rows().map((row) => Math.abs(row.value ?? 0))),
  );

  barWidth(valor: number | null): number {
    if (valor === null || !Number.isFinite(valor)) {
      return 0;
    }
    return Math.min(100, (Math.abs(valor) / this.maximo()) * 100);
  }

  format(row: MetricRow): string {
    // Offsets y contadores se ensenan como enteros; el resto con decimales utiles.
    return Number.isInteger(row.value) ? formatInteger(row.value) : formatNumber(row.value);
  }

  shorten(label: string): string {
    return shortLabel(label, 34);
  }
}
