import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PanelState } from '../core/metrics.service';

/**
 * Panel `transacciones`: exactly-once, honestamente.
 *
 * Este panel **no tiene serie** y no es un fallo de la pagina: en este Prometheus no existen
 * contadores de confirmadas frente a abortadas. kafka-exporter solo publica offsets, lag, grupos e
 * ISR, y las series `kafka_producer_txn_*_time_ns_total` del cliente son TIEMPOS (y valen 0), no un
 * recuento.
 *
 * La tentacion era rellenarlo con algo que se le pareciera. El contrato lo prohibe y hace bien: un
 * panel vacio que explica el hueco ensena mas que un numero inventado. Lo que se vigila de verdad
 * para exactly-once es el lag de `orders.executions`, y eso esta en el panel Lag.
 */
@Component({
  selector: 'app-transactions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gap">
      <span class="icon" aria-hidden="true">&#8709;</span>
      <div>
        <p class="headline">This panel is empty on purpose.</p>
        <p class="body">
          There is no committed-versus-aborted counter in this Prometheus, so there is nothing honest
          to draw. The dashboard does not fill the gap with a number that looks like one.
        </p>
      </div>
    </div>

    @if (state().note) {
      <blockquote class="nota">{{ state().note }}</blockquote>
    }

    <ul class="facts">
      <li>
        <strong>What would prove exactly-once:</strong> the committed/aborted counters, which do not
        exist here. kafka-exporter publishes offsets, lag, groups and ISR, and nothing else.
      </li>
      <li>
        <strong>What is used instead:</strong> <code>scripts/ExactlyOnceRaceCheck.java</code> proves it
        against the real cluster (the aborted transaction is invisible under <code>read_committed</code>
        and present in the log under <code>read_uncommitted</code>), and the lag of
        <code>orders.executions</code> is watched day to day. That lag is in the Lag panel.
      </li>
      <li>
        <strong>Why the page will not fake it:</strong> a made-up transaction count would be worse than
        no panel, because somebody would end up trusting it during an incident.
      </li>
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .gap {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 10px;
      border: 1px dashed color-mix(in srgb, var(--info) 45%, var(--line));
      border-radius: 8px;
      background: color-mix(in srgb, var(--info) 8%, transparent);
    }
    .icon {
      font-size: 22px;
      line-height: 1;
      color: var(--info);
    }
    .headline {
      margin: 0 0 3px;
      font-size: 13px;
      font-weight: 650;
      color: var(--ink);
    }
    .body {
      margin: 0;
      font-size: 11.5px;
      color: var(--ink-soft);
      line-height: 1.45;
    }
    .nota {
      margin: 8px 0 0;
      padding: 7px 9px;
      border-left: 2px solid var(--info);
      background: var(--surface-2);
      border-radius: 4px;
      font-size: 11.5px;
      color: var(--ink-soft);
      line-height: 1.45;
    }
    .facts {
      margin: 8px 0 0;
      padding-left: 16px;
      display: grid;
      gap: 5px;
    }
    .facts li {
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.45;
    }
    .facts strong {
      color: var(--ink-soft);
    }
    code {
      font-family: var(--mono);
      font-size: 10.5px;
      color: var(--ink-soft);
      background: var(--surface-2);
      padding: 0 3px;
      border-radius: 3px;
    }
  `,
})
export class TransactionsPanel {
  readonly state = input.required<PanelState>();
}
