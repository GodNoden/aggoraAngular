import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LiveState } from '../core/live.service';
import { PanelState } from '../core/metrics.service';
import { SERIES_PALETTE } from '../core/panel-docs';
import { LineChart } from '../charts/line-chart';
import { MetricList } from '../ui/metric-list';
import { MetricRow } from '../ui/format';
import { lastValue } from '../core/contract.parser';

/**
 * Panel `lag`: cuanto le falta a cada consumidor.
 *
 * La grafica es la ventana del **WebSocket** (los ticks que el gateway resume) porque la ventana
 * movil del lag no existe: Prometheus devuelve un punto instantaneo por serie, sin historia. El
 * valor de cada grupo sale del catalogo.
 *
 * Aviso de color: el lag **puede ser negativo** y eso es normal (el exporter calcula la diferencia
 * entre el ultimo offset confirmado y el final del log, y durante un instante eso da -1 o -3). Un
 * negativo pequeno no es un problema; por eso el cerco esta en 0 y no en cualquier numero.
 */
@Component({
  selector: 'app-lag-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, MetricList],
  template: `
    <div class="window">
      <app-line-chart
        [values]="window()"
        color="#5aa9ff"
        [includeZero]="true"
        [ariaLabel]="'ticks per second seen by this stack during the last minute'"
      />
      <p class="caption">
        Last {{ window().length }} s of ticks seen by this stack: the shape you want in lag is a
        sawtooth that returns to zero, not a line that only climbs.
      </p>
    </div>

    @if (groups().length > 0) {
      <app-metric-list [rows]="rows()" [compact]="true" emptyText="no consumer group has a lag series right now" />
      <p class="caption">
        {{ groups().length }} consumer groups reported. A dash means the group exists but the series
        has no point yet.
      </p>
    } @else {
      <p class="waiting">waiting for the first metrics poll...</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .window {
      margin-bottom: 8px;
    }
    .caption {
      margin: 4px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
    .waiting {
      font-size: 12px;
      color: var(--ink-faint);
      font-style: italic;
      margin: 0;
    }
  `,
})
export class LagPanel {
  readonly live = input.required<LiveState>();
  readonly state = input.required<PanelState>();

  readonly window = computed(() => this.live().history.map((punto) => punto.ticksIn));

  readonly groups = computed(() => this.state().data?.series ?? []);

  readonly rows = computed<readonly MetricRow[]>(() =>
    this.groups().map((serie, indice) => {
      const valor = lastValue(serie);
      return {
        label: serie.label,
        value: valor,
        color: SERIES_PALETTE[indice % SERIES_PALETTE.length],
        // Un lag alto sostenido es aviso; negativo pequeno es normal, no se pinta en rojo.
        tone: valor === null ? 'muted' : valor > 500 ? 'bad' : valor > 50 ? 'warn' : valor < 0 ? 'muted' : 'ok',
      } satisfies MetricRow;
    }),
  );
}
