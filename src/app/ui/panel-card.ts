import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PanelDoc } from '../core/panel-docs';
import { PanelState } from '../core/metrics.service';
import { formatClock, formatAge } from './format';

/**
 * La tarjeta de un panel: la frase de "que estas viendo" arriba, el dato en medio y el "por que
 * importa" abajo.
 *
 * El orden es a proposito. Primero el dato, porque es lo que se viene a ver; luego la explicacion,
 * porque esto es material de aprendizaje. La cabecera dice siempre la procedencia (que endpoint y
 * que stack) para que nadie tenga que adivinar de donde sale el numero.
 */
@Component({
  selector: 'app-panel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="card" [attr.data-status]="state().status">
      <header>
        <div class="titles">
          <h3>{{ doc().title }}</h3>
          <span class="origin">{{ origin() }}</span>
        </div>
        <div class="badges">
          @if (state().status === 'loading') {
            <span class="badge loading">loading</span>
          } @else if (state().status === 'empty') {
            <span class="badge empty">no data</span>
          } @else if (state().status === 'error') {
            <span class="badge error">error</span>
          } @else {
            <span class="badge ok">{{ state().data?.series?.length ?? 0 }} series</span>
          }
          @if (state().elapsedMs !== null) {
            <span class="badge muted">{{ state().elapsedMs }} ms</span>
          }
          @if (state().fetchedAt) {
            <span class="badge muted" [title]="clock(state().fetchedAt)">{{ age }}</span>
          }
        </div>
      </header>

      <p class="what">{{ doc().what }}</p>

      <div class="body">
        <ng-content />
      </div>

      @if (state().status === 'empty') {
        <p class="note">
          <strong>No data, and the backend says why:</strong>
          {{ state().note || 'the panel came back empty without a note (the contract asks for one)' }}
        </p>
      }
      @if (state().status === 'error') {
        <p class="note error">{{ state().note }}</p>
      }
      @for (warning of state().warnings; track warning) {
        <p class="note warn">{{ warning }}</p>
      }

      <footer>
        <p class="why">{{ doc().why }}</p>
      </footer>
    </article>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .card {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px 14px 10px;
      gap: 8px;
    }
    .card[data-status='error'] {
      border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
    }
    .card[data-status='empty'] {
      border-color: color-mix(in srgb, var(--info) 35%, var(--line));
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }
    .titles {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
      color: var(--ink);
      letter-spacing: 0.01em;
    }
    .origin {
      font-size: 10.5px;
      color: var(--ink-faint);
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badges {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--ink-soft);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .badge.ok {
      color: var(--ok);
      border-color: color-mix(in srgb, var(--ok) 40%, var(--line));
    }
    .badge.empty {
      color: var(--info);
      border-color: color-mix(in srgb, var(--info) 40%, var(--line));
    }
    .badge.error {
      color: var(--bad);
      border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
    }
    .badge.loading {
      color: var(--warn);
    }
    .what {
      margin: 0;
      font-size: 12px;
      color: var(--ink-soft);
      line-height: 1.4;
    }
    .body {
      flex: 1 1 auto;
      min-height: 0;
    }
    .note {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--ink-soft);
      background: color-mix(in srgb, var(--info) 10%, transparent);
      border-left: 2px solid var(--info);
      padding: 6px 8px;
      border-radius: 4px;
    }
    .note.error {
      color: var(--bad);
      background: color-mix(in srgb, var(--bad) 10%, transparent);
      border-left-color: var(--bad);
    }
    .note.warn {
      color: var(--warn);
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      border-left-color: var(--warn);
    }
    footer {
      border-top: 1px solid var(--line);
      padding-top: 7px;
    }
    .why {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--ink-faint);
    }
    .why::before {
      content: 'Why it matters: ';
      color: var(--ink-soft);
      font-weight: 600;
    }
  `,
})
export class PanelCard {
  readonly doc = input.required<PanelDoc>();
  readonly state = input.required<PanelState>();
  /** De donde sale el dato: endpoint y stack. */
  readonly origin = input('');
  /**
   * Reloj de la pantalla, en ms. Se pasa como input en vez de leer `Date.now()` en la plantilla
   * porque una funcion que cambia en cada comprobacion es la forma mas facil de provocar un
   * `ExpressionChangedAfterItHasBeenChecked`; con un input, el valor es estable dentro del ciclo.
   */
  readonly now = input(Date.now());

  clock(valor: number | null): string {
    return formatClock(valor);
  }

  get age(): string {
    return formatAge(this.state().fetchedAt, this.now());
  }
}
