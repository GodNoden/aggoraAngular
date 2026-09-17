import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PanelState } from '../core/metrics.service';
import { SeriesView } from './series-view';
import { PanelName, Stack } from '../core/contract';

/**
 * Panel `particiones`: el log avanzando.
 *
 * Cada particion es una serie. El offset absoluto siempre sube, asi que una linea plana significa
 * "esta particion no recibe", no "va despacio". Los topics se listan por separado para que se vea
 * que spring y quarkus escriben en topics distintos (`market.ticks.canonical` frente a
 * `market.ticks.canonical.q`).
 */
@Component({
  selector: 'app-partitions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SeriesView],
  template: `
    <app-series-view
      [state]="state()"
      [panel]="panel()"
      [stack]="stack()"
      [limit]="12"
      [hints]="{}"
    >
      <div class="topics">
        @for (topic of topics(); track topic.label) {
          <span class="topic" [title]="topic.label">{{ topic.label }}</span>
        }
      </div>
      <p class="caption">
        {{ count() }} partitions across {{ topics().length }} topics. A flat line is a partition
        nobody is writing to; a line that jumps is a burst. <code>canonical</code> is written by
        Spring and <code>canonical.q</code> by Quarkus: that is the same data written twice by two
        implementations.
      </p>
    </app-series-view>
  `,
  styles: `
    :host {
      display: block;
    }
    .topics {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .topic {
      font-size: 10px;
      font-family: var(--mono);
      color: var(--ink-faint);
      border: 1px solid var(--line);
      border-radius: 3px;
      padding: 1px 5px;
    }
    .caption {
      margin: 6px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class PartitionsPanel {
  readonly state = input.required<PanelState>();
  readonly panel = input.required<PanelName>();
  readonly stack = input.required<Stack>();

  readonly count = computed(() => this.state().data?.series.length ?? 0);

  /** Topics distintos que aparecen en el panel, con su numero de particiones. */
  readonly topics = computed(() => {
    const cuenta = new Map<string, number>();
    for (const serie of this.state().data?.series ?? []) {
      const [topic] = serie.label.split('/');
      cuenta.set(topic, (cuenta.get(topic) ?? 0) + 1);
    }
    return [...cuenta.entries()].map(([topic, particiones]) => ({
      label: `${topic} (${particiones})`,
    }));
  });
}
