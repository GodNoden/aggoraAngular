import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AlertMessage } from '../core/contract';
import { formatClock } from './format';

/**
 * Lista de eventos inmediatos: alertas y posiciones.
 *
 * Los snapshots no salen aqui a proposito: son uno por segundo y llenarian la pantalla. Las alertas
 * y las posiciones son pocas y van al momento, que es justo lo que se quiere ver sin esperar.
 */
@Component({
  selector: 'app-event-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (alerts().length === 0) {
      <p class="empty">{{ emptyText() }}</p>
    } @else {
      <ul class="feed">
        @for (alerta of alerts(); track alerta.raisedAt + alerta.subject + alerta.type) {
          <li class="item" [attr.data-severity]="alerta.severity">
            <span class="chip">{{ alerta.severity }}</span>
            <span class="subject">{{ alerta.subject }}</span>
            <span class="type">{{ alerta.type }}</span>
            <span class="clock">{{ clock(alerta.raisedAt || alerta.ts) }}</span>
            <p class="detail">{{ alerta.detail }}</p>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .feed {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
      max-height: 260px;
      overflow-y: auto;
    }
    .item {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      align-items: baseline;
      gap: 6px;
      padding: 5px 7px;
      background: var(--surface-2);
      border-left: 2px solid var(--ink-faint);
      border-radius: 4px;
    }
    .item[data-severity='CRITICAL'] {
      border-left-color: var(--bad);
    }
    .item[data-severity='WARNING'] {
      border-left-color: var(--warn);
    }
    .item[data-severity='INFO'] {
      border-left-color: var(--info);
    }
    .chip {
      font-size: 10px;
      letter-spacing: 0.06em;
      color: var(--ink-faint);
      text-transform: uppercase;
    }
    .item[data-severity='CRITICAL'] .chip {
      color: var(--bad);
    }
    .item[data-severity='WARNING'] .chip {
      color: var(--warn);
    }
    .subject {
      font-weight: 600;
      color: var(--ink);
      font-size: 12.5px;
    }
    .type {
      color: var(--ink-soft);
      font-size: 11px;
    }
    .clock {
      color: var(--ink-faint);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .detail {
      grid-column: 1 / -1;
      margin: 0;
      font-size: 11.5px;
      color: var(--ink-soft);
      line-height: 1.35;
    }
    .empty {
      margin: 0;
      font-size: 12.5px;
      color: var(--ink-faint);
      font-style: italic;
    }
  `,
})
export class EventFeed {
  readonly alerts = input<readonly AlertMessage[]>([]);
  readonly emptyText = input('no alerts yet: silence here is good news');

  clock(valor: string): string {
    return formatClock(valor);
  }
}
