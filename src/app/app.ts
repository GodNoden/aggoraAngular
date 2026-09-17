import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  DoCheck,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  COMPARABLE_PANELS,
  ComparablePanel,
  PanelName,
  STACKS,
  Stack,
  StackMode,
} from './core/contract';
import { LiveService } from './core/live.service';
import { MetricsService } from './core/metrics.service';
import { AnalyticsService } from './core/analytics.service';
import { environment } from '../environments/environment';
import { PANEL_DOCS, SERIES_PALETTE } from './core/panel-docs';
import { PanelCard } from './ui/panel-card';
import { MetricList } from './ui/metric-list';
import { PulsePanel } from './live/pulse-panel';
import { LagPanel } from './live/lag-panel';
import { PartitionsPanel } from './live/partitions-panel';
import { DeadLettersPanel } from './live/dead-letters-panel';
import { HealthPanel } from './live/health-panel';
import { TransactionsPanel } from './live/transactions-panel';
import { LiveEventsPanel } from './live/live-events-panel';
import { AnalyticsPanel } from './ui/analytics-panel';
import { LessonsPanel } from './ui/lessons-panel';
import { Verify } from './verify';
import { MetricRow, formatAge, formatInteger } from './ui/format';
import { lastValue } from './core/contract.parser';
import { wsUrl } from './core/urls';

/** Los paneles de metricas con su forma de pintarse. */
type PanelView = 'pulse' | 'lag' | 'series' | 'health' | 'transactions';

interface PanelSlot {
  readonly panel: PanelName;
  readonly view: PanelView;
}

/**
 * Los paneles del catalogo, en el orden en que se leen: del latido a la letra pequena.
 *
 * `comparativa` no esta en esta lista y no es un olvido: no es un panel mas, es **el modo** en que
 * se pinta cualquier otro panel (selector "Side by side"), y por eso vive en la barra de arriba.
 */
const SLOTS: readonly PanelSlot[] = [
  { panel: 'pulso', view: 'pulse' },
  { panel: 'lag', view: 'lag' },
  { panel: 'particiones', view: 'series' },
  { panel: 'descartes', view: 'series' },
  { panel: 'salud', view: 'health' },
  { panel: 'transacciones', view: 'transactions' },
];

/**
 * El dashboard: de solo lectura, con selector de stack y modo leccion.
 *
 * Tres decisiones que se notan en la pantalla:
 *
 *  1. **El selector tiene tres posiciones**, no dos: Spring, Quarkus y *both*. El modo lado a lado es
 *     la firma del proyecto (el mismo pipeline implementado dos veces), asi que es una posicion de
 *     primera clase y no un extra escondido.
 *  2. **Cada panel dice que estas viendo y por que importa.** Es material de aprendizaje, no un
 *     Grafana con otro color.
 *  3. **Nada se rellena.** Un panel sin serie dice "no data" y repite la nota del backend; un error
 *     de red se ensena como error, con la URL que fallo.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PanelCard,
    MetricList,
    PulsePanel,
    LagPanel,
    PartitionsPanel,
    DeadLettersPanel,
    HealthPanel,
    TransactionsPanel,
    LiveEventsPanel,
    AnalyticsPanel,
    LessonsPanel,
    Verify,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy, DoCheck, AfterViewChecked {
  protected readonly live = inject(LiveService);
  protected readonly metrics = inject(MetricsService);
  protected readonly analytics = inject(AnalyticsService);

  protected readonly stacks = STACKS;
  protected readonly slots = SLOTS;
  protected readonly docs = PANEL_DOCS;
  protected readonly comparablePanels = COMPARABLE_PANELS;
  protected readonly mode = signal<StackMode>('spring');
  /** Panel resaltado desde el modo leccion. */
  protected readonly highlighted = signal<PanelName | null>(null);

  protected readonly intervalSeconds = Math.round(environment.metricsIntervalMs / 1000);
  protected readonly windowSeconds = environment.tickWindow;

  /**
   * Reloj de la pantalla: se repinta una vez por segundo para que "hace 3 s" no se quede congelado.
   * Es una signal, no una llamada a `Date.now()` en la plantilla, para no cambiar valores a mitad de
   * ciclo de deteccion.
   */
  private readonly reloj = signal(Date.now());
  readonly now = this.reloj.asReadonly();

  private readonly latido = setInterval(() => this.reloj.set(Date.now()), 1000);

  /**
   * Cuantas veces se ha ejecutado la deteccion de cambios.
   *
   * Existe para diagnosticar un sintoma concreto: si la pagina se queda colgada y los datos no
   * llegan, la causa mas probable es un bucle de deteccion de cambios que satura el hilo principal y
   * deja sin turno a las respuestas HTTP. Se puede leer desde fuera en `<pre id="diag-report">` y con
   * `?diag=1`. No se usa para nada mas.
   */
  private readonly ciclos = signal(0);
  private readonly lineasDiag = signal<readonly string[]>([]);
  private inicioVentana = Date.now();
  private ciclosEnVentana = 0;
  /** Bucle de deteccion de cambios detectado: solo puede ser un bug de la app. */
  readonly bucleDetectado = signal(false);

  ngDoCheck(): void {
    this.ciclosEnVentana += 1;
    const ahora = Date.now();
    if (ahora - this.inicioVentana > 1000) {
      const porSegundo = this.ciclosEnVentana;
      this.inicioVentana = ahora;
      this.ciclosEnVentana = 0;
      this.ciclos.update((valor) => valor + porSegundo);
      if (porSegundo > 200 && !this.bucleDetectado()) {
        this.bucleDetectado.set(true);
      }
      this.actualizarDiag(porSegundo);
    }
  }

  ngAfterViewChecked(): void {
    this.actualizarDiag(null);
  }

  /** Informe de diagnostico en el DOM, legible sin abrir la consola. */
  private actualizarDiag(ciclosPorSegundo: number | null): void {
    if (typeof document === 'undefined') {
      return;
    }
    let pre = document.getElementById('diag-report');
    if (!pre && !this.modoDiag) {
      return;
    }
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'diag-report';
      pre.style.cssText =
        'margin:12px;padding:10px;border:1px solid #7f1d1d;border-radius:8px;background:#120d14;' +
        'color:#ffd9a0;font:11px/1.5 monospace;white-space:pre-wrap;';
      document.body.appendChild(pre);
    }
    const paneles = Object.values(this.metrics.panels());
    const porEstado: Record<string, number> = {};
    for (const panel of paneles) {
      porEstado[panel.status] = (porEstado[panel.status] ?? 0) + 1;
    }
    const lineas = [
      `change detection: total=${this.ciclos()}${ciclosPorSegundo !== null ? ` (last second: ${ciclosPorSegundo})` : ''}`,
      `loop detected: ${this.bucleDetectado()}`,
      `panels: ${JSON.stringify(porEstado)}`,
      `socket spring: ${this.live.live().spring.state} | quarkus: ${this.live.live().quarkus.state}`,
      `messages parsed: ${this.live.messageCount()}`,
      `backend from the browser: ${this.backendReachable()}`,
      '--- sonda cruda (antes de Angular) ---',
      ...this.lineasSonda(),
      ...this.lineasDiag(),
    ];
    pre.textContent = lineas.join('\n');
  }

  /** Si el navegador puede hablar con el gateway, medido desde el propio navegador. */
  private readonly backendReachable = signal<string>('not measured');

  /**
   * Mide si el navegador alcanza el gateway, que NO es lo mismo que si lo alcanza la terminal.
   *
   * Este es el diagnostico que faltaba: cuando la pagina vive en un sitio y el backend en otro
   * (aqui: la app la sirve WSL y el navegador es el de Windows), la red del navegador puede no ver
   * `localhost:8089` aunque `curl` si lo vea. Se mide con una peticion de verdad y con tiempo limite.
   */
  async medirBackend(): Promise<void> {
    // Primero una URL del mismo origen (sirve el propio dev server): sirve de control para saber si
    // el problema es la red del navegador o solo el salto a otro puerto.
    const urls = [location.origin + '/favicon.ico', this.origen('pulso', 'spring')];
    for (const url of urls) {
      const inicio = Date.now();
      try {
        const control = new AbortController();
        const limite = setTimeout(() => control.abort(), 4000);
        const respuesta = await fetch(url, { signal: control.signal });
        clearTimeout(limite);
        // Se lee el cuerpo: si el cuerpo no llega, la peticion no sirve de nada.
        const texto = await respuesta.text();
        this.backendReachable.set(`${url} -> HTTP ${respuesta.status}, ${texto.length} B en ${Date.now() - inicio} ms`);
        return;
      } catch (error) {
        this.backendReachable.set(`${url} -> FALLO en ${Date.now() - inicio} ms: ${String(error)}`);
      }
    }
  }

  /** Lineas que midio la sonda cruda de `index.html`, si ya termino. */
  private lineasSonda(): readonly string[] {
    const sonda = (globalThis as { __aggoraProbe?: { lines: string[]; listo: boolean } }).__aggoraProbe;
    if (!sonda) {
      return ['(la sonda no existe: index.html no la ejecuto)'];
    }
    return [...sonda.lines, sonda.listo ? '(sonda terminada)' : '(sonda en curso)'];
  }

  /** Permite anotar lineas en el informe de diagnostico desde los servicios. */
  anotarDiag(linea: string): void {
    this.lineasDiag.update((actuales) => [...actuales, linea]);
  }

  constructor() {
    void this.medirBackend();
    this.live.start();
    this.metrics.start();
    void this.analytics.query(
      environment.defaultAnalyticsSymbol,
      environment.defaultAnalyticsMinutes,
    );
  }

  ngOnDestroy(): void {
    // El root no se destruye en produccion, pero en los tests si: sin esto, el intervalo se queda
    // vivo y Karma avisa de que no termina.
    clearInterval(this.latido);
    this.live.stop();
    this.metrics.stop();
  }

  /** Los stacks visibles segun el selector. */
  readonly visibles = computed<readonly Stack[]>(() => {
    const modo = this.mode();
    return modo === 'both' ? STACKS : [modo];
  });

  readonly ambos = computed(() => this.mode() === 'both');

  /** Filas de la vista de particiones: todas las series, ordenadas por topic. */
  filasParticiones(stack: Stack): readonly MetricRow[] {
    const series = this.metrics.panel('particiones', stack).data?.series ?? [];
    return [...series]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((serie, indice) => ({
        label: serie.label,
        value: lastValue(serie),
        color: SERIES_PALETTE[indice % SERIES_PALETTE.length],
        tone: 'ok' as const,
      }));
  }

  /** Filas de descartes: lo que no es cero primero, y con aviso. */
  filasDescartes(stack: Stack): readonly MetricRow[] {
    const series = this.metrics.panel('descartes', stack).data?.series ?? [];
    return [...series]
      .sort((a, b) => (lastValue(b) ?? 0) - (lastValue(a) ?? 0))
      .map((serie, indice) => {
        const valor = lastValue(serie);
        return {
          label: serie.label,
          value: valor,
          color:
            (valor ?? 0) > 0 ? '#ff6b8b' : SERIES_PALETTE[indice % SERIES_PALETTE.length],
          tone: (valor ?? 0) > 0 ? ('warn' as const) : ('ok' as const),
          hint:
            (valor ?? 0) > 0
              ? 'messages parked here: read the x-dlt-reason header of each one'
              : undefined,
        };
      });
  }

  /** Estado del panel de comparativa del stack que se esta mirando. */
  readonly comparativa = computed(() =>
    this.metrics.panel('comparativa', this.mode() === 'quarkus' ? 'quarkus' : 'spring'),
  );

  /** Filas de la comparativa: las dos series lado a lado, con color por implementacion. */
  readonly filasComparativa = computed<readonly MetricRow[]>(() =>
    (this.comparativa().data?.series ?? []).map((serie, indice) => ({
      label: serie.label,
      value: lastValue(serie),
      color: serie.label.startsWith('quarkus')
        ? '#5aa9ff'
        : serie.label.startsWith('spring')
          ? '#3ddc97'
          : SERIES_PALETTE[indice % SERIES_PALETTE.length],
      tone: 'ok' as const,
    })),
  );

  protected readonly formatInteger = formatInteger;

  /** Origen del dato, para la cabecera de cada tarjeta. */
  origen(panel: PanelName, stack: Stack): string {
    const base = environment[stack].gateway || location.origin;
    return panel === 'comparativa'
      ? `${base}/api/metrics?panel=comparativa&de=${this.metrics.comparisonPanel()}`
      : `${base}/api/metrics?panel=${panel}`;
  }

  /** Nombre del stack para la UI. */
  etiqueta(stack: Stack): string {
    return environment[stack].label;
  }

  /** A donde apunta el socket de un stack: se ve en la pantalla sin abrir la consola. */
  urlSocket(stack: Stack): string {
    return wsUrl(environment[stack]);
  }

  /**
   * Aviso de "no hay a quien preguntar".
   *
   * Sin esto la pagina se queda en `loading` para siempre cuando el gateway no responde, y parece
   * que la app esta rota cuando lo que pasa es que el backend esta caido. Un panel aislado puede
   * fallar sin ruido, pero si TODOS fallan a la vez, se dice en la cabecera.
   */
  readonly sinBackend = computed(() => {
    const paneles = Object.values(this.metrics.panels());
    const conDatos = paneles.filter((estado) => estado.status === 'ok').length;
    const conError = paneles.filter((estado) => estado.status === 'error').length;
    return conDatos === 0 && conError > 0;
  });

  /** Mensaje del aviso, con la URL que fallo. */
  readonly avisoBackend = computed(() => {
    const errores = Object.values(this.metrics.panels()).filter((estado) => estado.status === 'error');
    const primero = errores[0];
    const cola = primero?.note ? ` ${primero.note}` : '';
    const otros = errores.length > 1 ? ` (+${errores.length - 1} more panels with the same problem)` : '';
    return `No panel is answering.${cola}${otros}`;
  });

  /** Estado del WebSocket de un stack, en una frase. */
  estadoSocket(stack: Stack): string {
    const estado = this.live.live()[stack];
    switch (estado.state) {
      case 'open':
        return estado.lastMessageAt
          ? `live · last message ${formatAge(estado.lastMessageAt, Date.now())}`
          : 'live, waiting for the first snapshot';
      case 'connecting':
        return 'connecting...';
      case 'reconnecting':
        return `reconnecting (attempt ${estado.reconnects})`;
      case 'closed':
        return 'socket closed';
      default:
        return 'not started';
    }
  }

  edad(fetchedAt: number | null): string {
    return formatAge(fetchedAt, Date.now());
  }

  cambiarModo(modo: StackMode): void {
    this.mode.set(modo);
    // Al cambiar de modo se repinta todo: `both` tiene el doble de tarjetas y conviene refrescar ya.
    void this.metrics.refreshAll();
  }

  elegirComparativa(panel: ComparablePanel): void {
    this.metrics.setComparisonPanel(panel);
  }

  /** Resalta un panel y baja hasta el (lo pide el modo leccion). */
  resaltar(panel: PanelName): void {
    this.highlighted.set(panel);
    if (typeof document !== 'undefined') {
      document.getElementById(`panel-${panel}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(() => this.highlighted.set(null), 2600);
  }

  readonly totalMensajes = this.live.messageCount;

  /**
   * Modo de comprobacion en vivo (`?verify=1`). Apagado por defecto: no forma parte del dashboard,
   * es la herramienta con la que se demuestra que el dashboard funciona contra el backend de verdad
   * (ver `src/app/verify.ts` y `npm run verify:live`).
   */
  readonly modoVerificacion =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('verify');

  /** Informe de diagnostico visible en la pagina (`?diag=1`). */
  readonly modoDiag =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('diag');
}
