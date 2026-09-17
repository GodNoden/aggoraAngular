import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { PanelState } from '../core/metrics.service';
import { MetricSeries } from '../core/contract';
import { lastValue } from '../core/contract.parser';
import { formatInteger, shortLabel } from '../ui/format';
import { LineChart } from '../charts/line-chart';
import { SeriesHistoryService } from '../core/series-history.service';
import { inject } from '@angular/core';

/** Una fila de salud ya clasificada por el prefijo de su etiqueta. */
interface HealthGroup {
  readonly key: 'targets' | 'engines' | 'isr';
  readonly title: string;
  readonly explanation: string;
  readonly items: readonly { label: string; value: number | null; tone: 'ok' | 'warn' | 'bad' }[];
  readonly badCount: number;
}

/**
 * Panel `salud`: quien esta vivo y quien solo lo parece.
 *
 * El contrato mete tres cosas distintas en el mismo panel y se separan a proposito, porque se leen
 * de forma distinta:
 *
 *  - `target` (`up`): un target a 0 es un scrape que falla. Suele ser el primer sintoma.
 *  - `stack/service` (`aggora_kafka_streams_running`): el motor de Streams. **Un 0 aqui con el
 *    proceso vivo es la leccion 5**: la sonda lo sabe y la lista de procesos no.
 *  - `under-replicated/<topic>`: cuantas copias le faltan a cada topic. Un 0 en los ~80 topics de
 *    prueba tapa el dato, asi que los que estan a 0 se colapsan en una sola linea y los que no,
 *    se ensenan uno a uno. Cuando el broker se cae (leccion 1) aqui es donde se ve.
 */
@Component({
  selector: 'app-health-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart],
  template: `
    <div class="verdict" [attr.data-tone]="verdict().tone">
      <span class="dot"></span>
      <span class="text">{{ verdict().text }}</span>
    </div>

    @for (group of groups(); track group.key) {
      <section class="group" [attr.data-key]="group.key">
        <header>
          <h4>{{ group.title }}</h4>
          @if (group.badCount > 0) {
            <span class="alert-count">{{ group.badCount }} not OK</span>
          }
        </header>
        <ul>
          @for (item of group.items; track item.label) {
            <li [attr.data-tone]="item.tone">
              <span class="mark" [attr.data-tone]="item.tone"></span>
              <span class="name" [title]="item.label">{{ shorten(item.label) }}</span>
              <app-line-chart
                class="spark"
                [values]="spark(item.label)"
                [color]="item.tone === 'ok' ? '#3ddc97' : item.tone === 'warn' ? '#ffb454' : '#ff6b8b'"
                [width]="90"
                [height]="18"
                [includeZero]="true"
                [ariaLabel]="item.label + ' health history'"
              />
              <span class="value">{{ item.value === null ? '--' : formatInteger(item.value) }}</span>
            </li>
          }
        </ul>
        <p class="explanation">{{ group.explanation }}</p>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .verdict {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--surface-2);
      margin-bottom: 8px;
    }
    .verdict .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--ok);
      flex: 0 0 auto;
    }
    .verdict[data-tone='warn'] .dot {
      background: var(--warn);
    }
    .verdict[data-tone='bad'] .dot {
      background: var(--bad);
    }
    .verdict .text {
      font-size: 12px;
      color: var(--ink-soft);
    }
    .group {
      padding: 6px 0;
      border-top: 1px dashed var(--line);
    }
    .group:first-of-type {
      border-top: 0;
    }
    .group header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
    }
    h4 {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ink-soft);
    }
    .alert-count {
      font-size: 10px;
      color: var(--bad);
      border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
      border-radius: 999px;
      padding: 1px 5px;
    }
    ul {
      list-style: none;
      margin: 4px 0 0;
      padding: 0;
      display: grid;
      gap: 1px;
      max-height: 150px;
      overflow-y: auto;
    }
    li {
      display: grid;
      grid-template-columns: auto minmax(70px, 1fr) 90px auto;
      align-items: center;
      gap: 7px;
      font-size: 11.5px;
      padding: 1px 0;
    }
    .mark {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ok);
    }
    .mark[data-tone='warn'] {
      background: var(--warn);
    }
    .mark[data-tone='bad'] {
      background: var(--bad);
    }
    .name {
      color: var(--ink-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: 10.5px;
    }
    .spark {
      --chart-height: 18px;
    }
    .value {
      font-variant-numeric: tabular-nums;
      color: var(--ink);
      text-align: right;
      min-width: 28px;
    }
    li[data-tone='bad'] .value {
      color: var(--bad);
    }
    li[data-tone='warn'] .value {
      color: var(--warn);
    }
    .explanation {
      margin: 5px 0 0;
      font-size: 11px;
      color: var(--ink-faint);
      line-height: 1.4;
    }
  `,
})
export class HealthPanel {
  private readonly history = inject(SeriesHistoryService);

  readonly state = input.required<PanelState>();
  readonly stack = input.required<'spring' | 'quarkus'>();

  /** Series de `under-replicated` que no valen 0 (las que si importan). */
  readonly isrProblems = computed(() =>
    this.seriesOf('under-replicated/').filter((serie) => (lastValue(serie) ?? 0) > 0),
  );

  readonly isrZeroCount = computed(
    () => this.seriesOf('under-replicated/').filter((serie) => (lastValue(serie) ?? 0) === 0).length,
  );

  readonly groups = computed<readonly HealthGroup[]>(() => {
    const targets = this.seriesOf('', 'under-replicated/');
    const engines = this.seriesOf('spring/').concat(
      this.state().data?.series.filter((serie) => serie.label.startsWith('quarkus/')) ?? [],
    );
    const isr = this.isrProblems();
    const isrCeros = this.isrZeroCount();

    const grupos: HealthGroup[] = [
      {
        key: 'targets',
        title: 'Prometheus targets (up)',
        explanation:
          'Every target at 1 means Prometheus can scrape it. A 0 here is the first symptom to look at: without scrapes there is no metrics catalog at all.',
        items: targets.map((serie) => ({
          label: serie.label,
          value: lastValue(serie),
          tone: tonoUp(lastValue(serie)),
        })),
        badCount: targets.filter((serie) => (lastValue(serie) ?? 1) < 1).length,
      },
      {
        key: 'engines',
        title: 'Kafka Streams engines',
        explanation:
          'aggora_kafka_streams_running per stack. 1 is a running engine; 0 with the process still up is lesson 5, and it is the probe, not the process list, that tells you.',
        items: engines.map((serie) => ({
          label: serie.label,
          value: lastValue(serie),
          tone: tonoUp(lastValue(serie)),
        })),
        badCount: engines.filter((serie) => (lastValue(serie) ?? 1) < 1).length,
      },
      {
        key: 'isr',
        title: 'Under-replicated partitions',
        explanation:
          isrCeros > 0
            ? `${isrCeros} topics are at 0 and are collapsed, because in this environment there are dozens of leftover test topics that would bury the signal. Only topics above 0 are listed.`
            : 'No topic is under-replicated right now: every partition has all its copies. This is the panel that moves in lesson 1.',
        items: isr.map((serie) => ({
          label: serie.label,
          value: lastValue(serie),
          tone: 'bad' as const,
        })),
        badCount: isr.length,
      },
    ];
    // Grupos vacios fuera: un panel de salud sin engines no debe ocupar sitio con una lista vacia.
    return grupos.filter((grupo) => grupo.items.length > 0);
  });

  readonly verdict = computed(() => {
    const problemas = this.groups().reduce((suma, grupo) => suma + grupo.badCount, 0);
    if (problemas === 0) {
      return { tone: 'ok' as const, text: 'Everything the catalog can see is healthy.' };
    }
    if (this.isrProblems().length > 0) {
      return {
        tone: 'bad' as const,
        text: `${this.isrProblems().length} topics are under-replicated: Kafka is running with fewer copies than it wants. That is lesson 1, live.`,
      };
    }
    return { tone: 'warn' as const, text: `${problemas} checks are not OK.` };
  });

  spark(label: string): readonly number[] {
    return this.history.values(this.state().panel, this.stack(), label);
  }

  private seriesOf(prefijo: string, excluir?: string): readonly MetricSeries[] {
    return (this.state().data?.series ?? []).filter(
      (serie) =>
        serie.label.startsWith(prefijo) && (!excluir || !serie.label.startsWith(excluir)),
    );
  }

  shorten(label: string): string {
    return shortLabel(label, 34);
  }

  protected readonly formatInteger = formatInteger;
}

function tonoUp(valor: number | null): 'ok' | 'warn' | 'bad' {
  if (valor === null) {
    return 'warn';
  }
  return valor >= 1 ? 'ok' : 'bad';
}
