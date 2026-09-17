import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PanelState } from '../core/metrics.service';
import { PanelName, Stack } from '../core/contract';
import { lastValue } from '../core/contract.parser';
import { SeriesView } from './series-view';
import { formatInteger } from '../ui/format';

/**
 * Panel `descartes`: lo que no se pudo procesar.
 *
 * Plano en verde es la buena noticia. Cada escalon es un mensaje que acabo en el DLT, y el motivo
 * viaja en la cabecera `x-dlt-reason` del propio mensaje: el dashboard no puede leerla (no lee
 * mensajes de Kafka, solo offsets), y eso se dice en vez de disimularlo.
 *
 * Los topics de reintento (`*.retry-500`, `*.retry-1000`) subiendo sin que suba el DLT significan
 * que algo se esta reintentando y todavia puede salvarse.
 */
@Component({
  selector: 'app-dead-letters-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SeriesView],
  template: `
    <div class="summary" [attr.data-tone]="tone()">
      <span class="total">{{ formatInteger(total()) }}</span>
      <span class="label">messages parked in dead-letter and retry topics</span>
    </div>

    <app-series-view [state]="state()" [panel]="panel()" [stack]="stack()" [limit]="12" />

    @if (dlts().length > 0) {
      <div class="reason">
        <p class="reason-head">Dead-letter topics seen:</p>
        <ul>
          @for (topic of dlts(); track topic.label) {
            <li>
              <code>{{ topic.label }}</code>
              <span class="delta">+{{ formatInteger(topic.value) }}</span>
            </li>
          }
        </ul>
        <p class="reason-note">
          Why each message landed there is in the message header <code>x-dlt-reason</code>, which this
          dashboard cannot read: it only sees offsets. To read it, use the console consumer from the
          lessons repo, not the page.
        </p>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .summary {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    .total {
      font-size: 26px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      color: var(--ok);
      line-height: 1;
    }
    .summary[data-tone='warn'] .total {
      color: var(--warn);
    }
    .summary[data-tone='bad'] .total {
      color: var(--bad);
    }
    .summary .label {
      font-size: 11.5px;
      color: var(--ink-faint);
    }
    .reason {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px dashed var(--line);
    }
    .reason-head {
      margin: 0 0 3px;
      font-size: 11px;
      color: var(--ink-soft);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 2px;
    }
    li {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
    }
    code {
      font-family: var(--mono);
      color: var(--ink-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .delta {
      color: var(--warn);
      font-variant-numeric: tabular-nums;
    }
    .reason-note {
      margin: 6px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class DeadLettersPanel {
  readonly state = input.required<PanelState>();
  readonly panel = input.required<PanelName>();
  readonly stack = input.required<Stack>();

  /** Topics de DLT (no los de reintento). */
  readonly dlts = computed(() =>
    (this.state().data?.series ?? [])
      .filter((serie) => serie.label.includes('DLT'))
      .map((serie) => ({ label: serie.label, value: lastValue(serie) ?? 0 })),
  );

  /** Suma de todo lo que hay en DLT y en los topics de reintento. */
  readonly total = computed(() =>
    (this.state().data?.series ?? []).reduce((suma, serie) => suma + (lastValue(serie) ?? 0), 0),
  );

  readonly tone = computed(() => {
    const valor = this.total();
    return valor === 0 ? 'ok' : valor < 10 ? 'warn' : 'bad';
  });

  protected readonly formatInteger = formatInteger;
}
