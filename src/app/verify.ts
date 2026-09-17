import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LiveService } from './core/live.service';
import { MetricsService } from './core/metrics.service';
import { AnalyticsService } from './core/analytics.service';
import { environment } from '../environments/environment';

/**
 * Modo de comprobacion en vivo: `?verify=1`.
 *
 * Existe porque este equipo es WSL con el navegador en Windows: no se puede pilotar Chrome desde
 * fuera (el puerto de depuracion de Windows no es alcanzable desde WSL), asi que la comprobacion la
 * hace **la propia pagina** y deja el resultado en el DOM, en un `<pre id="verify-report">` que se
 * lee con `--dump-dom`.
 *
 * Es de solo lectura, como el resto: no escribe en el backend y no aparece si no se pide con
 * `?verify=1`. Comprueba lo que el encargo pide verificar contra el backend de verdad:
 *
 *   (a) llegan snapshots cada segundo,
 *   (b) el pulso, el lag y el resto de paneles se pintan con datos reales,
 *   (c) el selector cambia entre Spring, Quarkus y el modo lado a lado, y
 *   (d) un panel sin serie dice "no data" y NO dibuja una grafica vacia.
 */

interface Comprobacion {
  readonly nombre: string;
  readonly ok: boolean;
  readonly detalle: string;
}

const ESPERA_MAXIMA_MS = 25000;

@Component({
  selector: 'app-verify',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <pre id="verify-report" [attr.data-verify]="estado()">{{ informe() }}</pre>
  `,
  styles: `
    :host {
      display: block;
    }
    pre {
      background: #05080d;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--ink-soft);
      overflow-x: auto;
      white-space: pre-wrap;
    }
  `,
})
export class Verify {
  private readonly live = inject(LiveService);
  private readonly metrics = inject(MetricsService);
  private readonly analytics = inject(AnalyticsService);

  readonly estado = signal('running');
  readonly informe = signal('verification running...\n');
  private readonly checks: Comprobacion[] = [];

  constructor() {
    setTimeout(() => void this.ejecutar(), 1500);
  }

  private anotar(nombre: string, ok: boolean, detalle = ''): void {
    this.checks.push({ nombre, ok, detalle });
    this.publicar();
  }

  private publicar(): void {
    const fallos = this.checks.filter((c) => !c.ok);
    this.estado.set(fallos.length === 0 && this.checks.length > 0 ? 'pass' : this.estado() === 'running' ? 'running' : 'fail');
    const lineas = this.checks.map(
      (c) => `${c.ok ? 'PASS' : 'FAIL'} | ${c.nombre}${c.detalle ? ` | ${c.detalle}` : ''}`,
    );
    this.informe.set(
      [
        `aggora-dashboard live verification`,
        `failures: ${fallos.length} of ${this.checks.length}`,
        '',
        ...lineas,
        '',
      ].join('\n'),
    );
  }

  /** Espera a que se cumpla una condicion, con tope de tiempo. */
  private async esperar(condicion: () => boolean, timeoutMs = ESPERA_MAXIMA_MS): Promise<boolean> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      if (condicion()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return condicion();
  }

  private historial(stack: 'spring' | 'quarkus'): number {
    return this.live.live()[stack].history.length;
  }

  private async ejecutar(): Promise<void> {
    const spring = () => this.live.live().spring;

    /* --- (a) WebSocket: snapshots cada segundo ------------------------------------------- */
    await this.esperar(() => this.historial('spring') >= 3, 30000);
    const historial = spring().history;
    this.anotar(
      'WebSocket: los snapshots llegan y se acumulan en la ventana movil',
      historial.length >= 3,
      `${historial.length} snapshots en la ventana (tope ${environment.tickWindow})`,
    );
    this.anotar(
      'WebSocket: el estado del socket esta abierto',
      spring().state === 'open',
      `estado=${spring().state}, reconexiones=${spring().reconnects}`,
    );
    const ticksIn = historial.at(-1)?.ticksIn ?? null;
    this.anotar(
      'WebSocket: la ultima foto trae ticks de entrada reales',
      ticksIn !== null && ticksIn > 0,
      `ticksIn=${ticksIn}`,
    );
    const simbolos = Object.keys(spring().lastSnapshot?.symbols ?? {}).length;
    this.anotar('WebSocket: la foto trae simbolos', simbolos > 0, `${simbolos} simbolos`);
    this.anotar(
      'WebSocket: la ventana se corta en tickWindow (no crece sin fin)',
      historial.length <= environment.tickWindow,
      `${historial.length} <= ${environment.tickWindow}`,
    );
    this.anotar(
      'WebSocket: no hay frames invalidos',
      spring().lastParseError === null,
      spring().lastParseError ? spring().lastParseError!.reason : 'sin errores de parseo',
    );
    const alertas = spring().alerts.length;
    const posiciones = spring().positions.length;
    this.anotar(
      'WebSocket: alertas y posiciones llegan al momento',
      alertas > 0 && posiciones > 0,
      `${alertas} alertas, ${posiciones} posiciones`,
    );

    /* --- (b) el catalogo de metricas ----------------------------------------------------- */
    await this.esperar(
      () => this.metrics.panel('pulso', 'spring').status !== 'loading' && this.metrics.panel('lag', 'spring').status !== 'loading',
      25000,
    );
    for (const panel of ['pulso', 'lag', 'particiones', 'descartes', 'salud'] as const) {
      const estado = this.metrics.panel(panel, 'spring');
      this.anotar(
        `Catalogo: el panel "${panel}" responde con datos`,
        estado.status === 'ok' && estado.data !== null && estado.data!.series.length > 0,
        `estado=${estado.status}, series=${estado.data?.series.length ?? 0}, ${estado.elapsedMs ?? '?'} ms`,
      );
    }
    const transacciones = this.metrics.panel('transacciones', 'spring');
    this.anotar(
      'Catalogo: el panel "transacciones" viene vacio CON nota (no es un error)',
      transacciones.status === 'empty' && Boolean(transacciones.note),
      `estado=${transacciones.status}, nota="${(transacciones.note ?? '').slice(0, 70)}..."`,
    );
    this.anotar(
      'Catalogo: no hay avisos de incumplimiento del contrato',
      Object.values(this.metrics.panels()).every((estado) => estado.warnings.length === 0),
      Object.values(this.metrics.panels())
        .flatMap((estado) => estado.warnings)
        .slice(0, 2)
        .join(' / '),
    );
    const gruposLag = this.metrics.panel('lag', 'spring').data?.series.map((s) => s.label) ?? [];
    this.anotar(
      'Catalogo: el lag trae los grupos de consumidores del contrato',
      gruposLag.some((label) => label.includes('normalizer')),
      gruposLag.join(', '),
    );
    const comparativa = this.metrics
      .panel('comparativa', 'spring')
      .data?.series.map((s) => s.label) ?? [];
    this.anotar(
      'Catalogo: "comparativa" devuelve las series de los dos stacks',
      comparativa.some((label) => label.startsWith('spring')) &&
        comparativa.some((label) => label.startsWith('quarkus')),
      comparativa.join(', '),
    );

    /* --- el pulso y el lag se pintan ------------------------------------------------------ */
    const trazosPulso = document.querySelectorAll('app-pulse-panel svg path.line').length;
    this.anotar('Pintado: el pulso dibuja sus lineas (ticks in y out)', trazosPulso >= 2, `${trazosPulso} trazos SVG`);
    const filasLag = document.querySelectorAll('app-lag-panel app-metric-list .row').length;
    const valoresLag = [...document.querySelectorAll('app-lag-panel app-metric-list .row .value')]
      .map((el) => el.textContent?.trim() ?? '')
      .filter((valor) => valor !== '' && valor !== '--');
    this.anotar(
      'Pintado: el lag ensena numeros por grupo, no guiones',
      filasLag > 0 && valoresLag.length > 0,
      `${filasLag} grupos, valores: ${valoresLag.join(' | ')}`,
    );
    const puntosGrafica = (() => {
      const path = document.querySelector('app-pulse-panel svg path.line');
      return path ? (path.getAttribute('d') ?? '').split('L').length - 1 : 0;
    })();
    this.anotar(
      'Pintado: la grafica del pulso acumula varios puntos',
      puntosGrafica >= 2,
      `${puntosGrafica} puntos en la polilinea`,
    );
    this.anotar(
      'Pintado: el panel de salud separa targets, motores e ISR',
      document.querySelectorAll('app-health-panel .group').length >= 2,
      `${document.querySelectorAll('app-health-panel .group').length} grupos de salud`,
    );
    this.anotar(
      'Pintado: las particiones traen topics del log',
      document.querySelectorAll('app-partitions-panel .topic').length >= 3,
      `${document.querySelectorAll('app-partitions-panel .topic').length} topics`,
    );

    /* --- (d) un panel sin serie no se rellena -------------------------------------------- */
    const celdaVacia = document.getElementById('panel-transacciones');
    const notaVacia = celdaVacia?.querySelector('.note')?.textContent?.trim() ?? '';
    const trazosVacios = celdaVacia?.querySelectorAll('svg path.line').length ?? 0;
    this.anotar(
      'Panel sin serie: ensena la nota del backend explicando el hueco',
      notaVacia.length > 0,
      notaVacia.slice(0, 80),
    );
    this.anotar(
      'Panel sin serie: NO dibuja una grafica vacia',
      trazosVacios === 0,
      `${trazosVacios} trazos dentro del panel`,
    );

    /* --- (c) el selector de stacks -------------------------------------------------------- */
    const botones = () => [...document.querySelectorAll<HTMLButtonElement>('.segmented button')];
    const pulsar = (texto: string): boolean => {
      const boton = botones().find((b) => b.textContent?.trim() === texto);
      boton?.click();
      return Boolean(boton);
    };
    const columnas = () => document.querySelectorAll('.column-title').length;
    const titulosColumnas = () =>
      [...document.querySelectorAll('.column-title')].map((el) => el.textContent?.trim()).join(' + ');

    this.anotar('Selector: existen las tres posiciones (Spring, Quarkus, los dos)', botones().length === 3, `${botones().length} botones`);

    const hayQuarkus = pulsar('Quarkus');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await this.esperar(() => this.metrics.panel('pulso', 'quarkus').status !== 'loading', 20000);
    const estadoQuarkus = this.metrics.panel('pulso', 'quarkus');
    this.anotar(
      'Selector: cambiar a Quarkus pide sus paneles al 8189',
      hayQuarkus && estadoQuarkus.data !== null,
      `puerto quarkus=${environment.quarkus.gateway}, estado=${estadoQuarkus.status}`,
    );
    this.anotar(
      'Selector: el socket de Quarkus tambien esta vivo',
      this.live.live().quarkus.state === 'open',
      `estado=${this.live.live().quarkus.state}, ticks=${this.historial('quarkus')}`,
    );
    this.anotar('Selector: con un solo stack no hay columnas', columnas() === 0, `${columnas()} columnas`);

    const hayAmbos = pulsar('Spring + Quarkus');
    await new Promise((resolve) => setTimeout(resolve, 900));
    this.anotar(
      'Selector: el modo lado a lado pinta dos columnas, una por stack',
      hayAmbos && columnas() === 2,
      titulosColumnas(),
    );
    const filasComparativa = document.querySelectorAll('.cell.compare app-metric-list .row').length;
    const etiquetasComparativa = [...document.querySelectorAll('.cell.compare app-metric-list .row .label')]
      .map((el) => el.textContent?.trim() ?? '')
      .join(', ');
    this.anotar(
      'Selector: la comparativa ensena spring/ y quarkus/ lado a lado',
      filasComparativa > 0 && etiquetasComparativa.includes('spring') && etiquetasComparativa.includes('quarkus'),
      etiquetasComparativa,
    );

    pulsar('Spring');
    await new Promise((resolve) => setTimeout(resolve, 400));

    /* --- modo leccion y consulta interactiva ---------------------------------------------- */
    const lecciones = document.querySelectorAll('.lesson').length;
    const comandos = [...document.querySelectorAll('.lesson .command code')].map((el) => el.textContent?.trim());
    this.anotar(
      'Modo leccion: estan las cinco lecciones con su comando',
      lecciones === 5 && comandos.some((c) => c?.includes('leccion-1-broker-caido.sh')) && comandos.some((c) => c?.includes('leccion-5-streams-muerto.sh')),
      `${lecciones} lecciones`,
    );
    this.anotar(
      'Modo leccion: no hay ningun boton que ejecute nada en el backend',
      ![...document.querySelectorAll('button')].some((b) => /^(run|execute|ejecutar)/i.test(b.textContent?.trim() ?? '')),
      'solo botones de copiar',
    );

    const analitica = this.analytics.analytics();
    this.anotar(
      'Consulta interactiva: /analytics responde a la pagina',
      analitica.status === 'ok' && analitica.windows.length > 0,
      `estado=${analitica.status}, ventanas=${analitica.windows.length}${analitica.note ? `, nota=${analitica.note.slice(0, 60)}` : ''}`,
    );

    const fallos = this.checks.filter((c) => !c.ok).length;
    this.estado.set(fallos === 0 ? 'pass' : 'fail');
    this.publicar();
  }
}
