import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { LESSONS, Lesson, SMOKE_COMMAND } from '../core/lessons';
import { PanelName } from '../core/contract';
import { PANEL_DOCS } from '../core/panel-docs';

/**
 * El modo leccion.
 *
 * Las cinco lecciones se lanzan **desde la terminal, dentro del devcontainer**. Esta pagina no
 * ejecuta nada y no tiene forma de hacerlo: no hay endpoint de escritura, y esa es la decision de
 * diseno, no una limitacion.
 *
 * Cada tarjeta dice el comando exacto, que panel mirar y que deberia cambiar. Al pulsar "Watch this
 * panel" se resalta el panel correspondiente arriba, que es lo unico que la pagina puede hacer:
 * observar y narrar.
 */
@Component({
  selector: 'app-lessons-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="explain">
      <p>
        Each lesson is a script in the backend repository. They are run <strong>from a terminal inside
        the devcontainer</strong>, never from this page: the dashboard is read-only and has no write
        endpoint to reach for, by design. What the page does is watch and narrate.
      </p>
      <p class="readonly">
        <span class="lock" aria-hidden="true">&#128274;</span>
        Copy the command, run it, and keep this page open on the panel named below.
      </p>
    </div>

    <div class="lessons">
      @for (lesson of lessons; track lesson.id) {
        <article class="lesson" [class.watching]="ultima() === lesson.id">
          <header>
            <span class="number">{{ lesson.number }}</span>
            <h4>{{ lesson.title }}</h4>
            <code class="script">{{ lesson.script }}</code>
          </header>

          <div class="command">
            <code>{{ lesson.command }}</code>
            <button type="button" (click)="copiar(lesson)" [class.copied]="copiado() === lesson.id">
              {{ copiado() === lesson.id ? 'copied' : 'copy' }}
            </button>
          </div>

          <div class="panels">
            <span class="label">Watch:</span>
            @for (panel of lesson.panels; track panel) {
              <button
                type="button"
                class="panel-chip"
                [class.active]="ultima() === lesson.id"
                (click)="ver(panel)"
                [title]="'Scroll to the ' + title(panel) + ' panel'"
              >
                {{ title(panel) }}
              </button>
            }
          </div>

          <p class="expectation"><strong>What you should see:</strong> {{ lesson.expectation }}</p>
          <p class="twist"><strong>The interesting part:</strong> {{ lesson.twist }}</p>

          <footer>
            <span class="where">
              runs in the {{ lesson.runsIn === 'devcontainer' ? 'devcontainer' : 'host' }}
              <span class="sep">·</span> from the aggora repository root
            </span>
          </footer>
        </article>
      }
    </div>

    <div class="smoke">
      <div>
        <p class="smoke-title">The executable check</p>
        <p class="smoke-body">
          The backend ships its own contract check. It hits every panel on both gateways, the
          side-by-side mode, the WebSocket, CORS and the closed catalog, and exits non-zero if
          anything is off. Run it before blaming the page.
        </p>
      </div>
      <div class="command">
        <code>{{ smokeCommand }}</code>
        <button type="button" (click)="copiarSmoke()" [class.copied]="copiado() === 'smoke'">
          {{ copiado() === 'smoke' ? 'copied' : 'copy' }}
        </button>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .explain p {
      margin: 0 0 5px;
      font-size: 12px;
      color: var(--ink-soft);
      line-height: 1.5;
    }
    .explain strong {
      color: var(--ink);
    }
    .readonly {
      color: var(--ink-faint) !important;
      font-size: 11.5px !important;
    }
    .lock {
      margin-right: 4px;
    }
    .lessons {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .lesson {
      display: flex;
      flex-direction: column;
      gap: 7px;
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 11px 12px;
      transition: border-color 200ms ease;
    }
    .lesson.watching {
      border-color: color-mix(in srgb, var(--info) 60%, var(--line));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--info) 25%, transparent);
    }
    .lesson header {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: baseline;
      gap: 8px;
    }
    .number {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--info) 22%, transparent);
      color: var(--ink);
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
      grid-row: span 2;
    }
    h4 {
      margin: 0;
      font-size: 13px;
      color: var(--ink);
      font-weight: 650;
      line-height: 1.3;
    }
    .script {
      grid-column: 2;
      font-family: var(--mono);
      font-size: 10px;
      color: var(--ink-faint);
    }
    .command {
      display: flex;
      align-items: stretch;
      gap: 6px;
    }
    .command code {
      flex: 1 1 auto;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--ok);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 5px 7px;
      overflow-x: auto;
      white-space: nowrap;
    }
    .command button {
      flex: 0 0 auto;
      background: var(--surface);
      border: 1px solid var(--line);
      color: var(--ink-soft);
      border-radius: 5px;
      font-size: 10.5px;
      font-family: inherit;
      padding: 0 9px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .command button.copied {
      color: var(--ok);
      border-color: color-mix(in srgb, var(--ok) 50%, var(--line));
    }
    .panels {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
    .panels .label {
      font-size: 10.5px;
      color: var(--ink-faint);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .panel-chip {
      background: transparent;
      border: 1px solid var(--line);
      color: var(--ink-soft);
      border-radius: 999px;
      font-size: 10.5px;
      font-family: inherit;
      padding: 2px 8px;
      cursor: pointer;
    }
    .panel-chip:hover,
    .panel-chip.active {
      color: var(--ink);
      border-color: color-mix(in srgb, var(--info) 55%, var(--line));
      background: color-mix(in srgb, var(--info) 12%, transparent);
    }
    .expectation,
    .twist {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.5;
      color: var(--ink-soft);
    }
    .expectation strong,
    .twist strong {
      color: var(--ink);
    }
    .twist {
      color: var(--ink-faint);
    }
    .lesson footer {
      margin-top: auto;
      border-top: 1px dashed var(--line);
      padding-top: 6px;
    }
    .where {
      font-size: 10px;
      color: var(--ink-faint);
    }
    .sep {
      margin: 0 3px;
    }
    .smoke {
      margin-top: 12px;
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: var(--surface-2);
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 12px;
      align-items: center;
    }
    .smoke-title {
      margin: 0 0 3px;
      font-size: 12.5px;
      font-weight: 650;
      color: var(--ink);
    }
    .smoke-body {
      margin: 0;
      font-size: 11.5px;
      color: var(--ink-faint);
      line-height: 1.45;
    }
    @media (max-width: 720px) {
      .smoke {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class LessonsPanel {
  readonly lessons = LESSONS;
  readonly smokeCommand = SMOKE_COMMAND;

  /** Panel que la pagina debe resaltar arriba, pedido desde una leccion. */
  readonly highlight = output<PanelName>();
  readonly copiado = signal<string | null>(null);
  /** Leccion cuyo comando se acaba de copiar (se resalta la tarjeta). */
  readonly ultima = signal<string | null>(null);

  private readonly docs = PANEL_DOCS;

  /** Copia el comando y pide que se resalte el primer panel de la leccion. */
  async copiar(lesson: Lesson): Promise<void> {
    await this.copiarTexto(lesson.command);
    this.copiado.set(lesson.id);
    this.ultima.set(lesson.id);
    const panel = lesson.panels[0];
    if (panel) {
      this.highlight.emit(panel);
    }
  }

  async copiarSmoke(): Promise<void> {
    await this.copiarTexto(SMOKE_COMMAND);
    this.copiado.set('smoke');
  }

  /** Pide al shell que resalte y lleve la vista al panel. */
  ver(panel: PanelName): void {
    this.highlight.emit(panel);
  }

  /** Copia al portapapeles sin romper la pagina si el navegador lo bloquea (sin https no hay API). */
  private async copiarTexto(texto: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(texto);
    } catch {
      // Sin permiso de portapapeles: el comando queda visible para copiarlo a mano.
    }
  }

  title(panel: PanelName): string {
    return this.docs[panel].title;
  }
}
