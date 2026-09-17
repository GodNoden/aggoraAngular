import {
  ChangeDetectionStrategy,
  Component,
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
export class App implements OnDestroy {
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

  /**
   * El informe de diagnostico, ya compuesto como texto.
   *
   * **Se calcula desde el reloj y se pinta con una interpolacion de la plantilla, no escribiendo el
   * DOM a mano.** Ese cambio es el arreglo de un fallo real de esta pagina: antes el informe se
   * reescribia dentro de `ngAfterViewChecked`, y en esta version de Angular ese hook puede no
   * ejecutarse aunque la vista se siga refrescando (medido: el reloj de la pantalla avanzaba y el
   * contador de `ngDoCheck` se quedaba en 2). Resultado: con `?diag=1` el informe se quedaba
   * congelado en el estado del arranque y parecia que la app no volvia a pedir nada.
   */
  protected readonly informeDiag = signal('');

  /**
   * Cuantas veces por segundo late el reloj: si esto se dispara, la deteccion de cambios esta en
   * bucle y el hilo principal no tiene turno para nada mas.
   */
  protected readonly latidosPorSegundo = signal(0);

  private readonly latido = setInterval(() => {
    const ahora = Date.now();
    this.reloj.set(ahora);
    this.contarLatido(ahora);
    if (this.modoDiag && !this.sinDiag) {
      this.informeDiag.set(this.componerInforme());
    }
  }, 1000);

  /** Ventana del latido: sirve para detectar un bucle de deteccion. */
  private inicioVentana = Date.now();
  private latidosEnVentana = 0;
  /** Bucle de deteccion de cambios detectado: solo puede ser un bug de la app. */
  readonly bucleDetectado = signal(false);

  private contarLatido(ahora: number): void {
    this.latidosEnVentana += 1;
    if (ahora - this.inicioVentana >= 1000) {
      this.latidosPorSegundo.set(this.latidosEnVentana);
      if (this.latidosEnVentana > 200 && !this.bucleDetectado()) {
        this.bucleDetectado.set(true);
      }
      this.latidosEnVentana = 0;
      this.inicioVentana = ahora;
    }
  }

  /**
   * Compone el informe: estados de los paneles, sockets, sonda cruda de red y las metricas del
   * navegador. Todo lo que hace falta para saber si la pagina esta viva sin abrir la consola.
   */
  private componerInforme(): string {
    const paneles = Object.values(this.metrics.panels());
    const porEstado: Record<string, number> = {};
    for (const panel of paneles) {
      porEstado[panel.status] = (porEstado[panel.status] ?? 0) + 1;
    }
    return [
      `latidos del reloj: ${this.latidosPorSegundo()} por segundo${this.bucleDetectado() ? '  *** BUCLE DE DETECCION ***' : ''}`,
      `panels: ${JSON.stringify(porEstado)}`,
      `ciclos de paneles descartados por colgarse: ${this.metrics.descartados}`,
      `socket spring: ${this.live.live().spring.state} | quarkus: ${this.live.live().quarkus.state}`,
      `messages parsed: ${this.live.messageCount()}`,
      `backend from the browser: ${this.backendReachable()}`,
      '--- sonda cruda (antes de Angular) ---',
      ...this.lineasSonda(),
      ...this.notasDiag,
    ].join('\n');
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

  /** Lineas que los servicios quieren anadir al informe de diagnostico. */
  private readonly notasDiag: string[] = [];

  /** Permite anotar lineas en el informe de diagnostico desde los servicios. */
  anotarDiag(linea: string): void {
    this.notasDiag.push(linea);
  }

  constructor() {
    traza('App: constructor inicio');
    /*
     * Interruptores de diagnostico, los dos que de verdad sirven para aislar un fallo sin recom
     * pilar:
     *
     *   `?solo=live|metrics|analytics`  arranca un unico servicio (los otros no se tocan).
     *   `?nodiag=1`                     apaga el repintado del informe de diagnostico.
     *
     * Nacieron del fallo de este repositorio: la pagina se quedaba en `loading` con el renderer
     * bloqueado, y con la app entera no habia forma de saber que pieza lo colgaba.
     */
    const solo = new URLSearchParams(location.search).get('solo');
    const sinDiag = new URLSearchParams(location.search).has('nodiag');
    const arranca = (nombre: 'live' | 'metrics' | 'analytics'): boolean => !solo || solo === nombre;
    this.solo = solo;
    this.sinDiag = sinDiag;
    traza(`App: interruptores solo=${solo ?? '(ninguno)'} nodiag=${sinDiag}`);
    void this.medirBackend();
    traza('App: medirBackend lanzado');
    if (arranca('live')) {
      this.live.start();
      traza('App: live.start hecho');
    } else {
      traza('App: live.start OMITIDO por ?solo=');
    }
    if (arranca('metrics')) {
      this.metrics.start();
      traza('App: metrics.start hecho');
    } else {
      traza('App: metrics.start OMITIDO por ?solo=');
    }
    if (arranca('analytics')) {
      void this.analytics.query(
        environment.defaultAnalyticsSymbol,
        environment.defaultAnalyticsMinutes,
      );
      traza('App: analytics.query lanzado');
    } else {
      traza('App: analytics.query OMITIDO por ?solo=');
    }
  }

  /** Diagnostico: que servicio se esta ejecutando (`?solo=<nombre>`), si se pidio. */
  private solo: string | null = null;
  /** Diagnostico: apaga el repintado del informe en cada ciclo de deteccion. */
  private sinDiag = false;

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

/**
 * Traza de arranque.
 *
 * Se apunta en `window.__aggoraTrace` en vez de en la consola porque en este equipo la consola del
 * navegador no siempre esta a mano, y el sintoma (la app pinta pero no carga datos) exige saber
 * hasta que linea del constructor se ejecuto.
 */
function traza(paso: string): void {
  const global = globalThis as { __aggoraTrace?: string[] };
  global.__aggoraTrace = global.__aggoraTrace ?? ['(traza inicializada)'];
  global.__aggoraTrace.push(`${Math.round(performance.now())} ms  ${paso}`);

  // Se pinta tambien en el DOM, para que se pueda leer sin consola ni informe.
  if (typeof document !== 'undefined') {
    const pintar = (): void => {
      if (!document.body) {
        return;
      }
      let pre = document.getElementById('boot-trace');
      if (!pre) {
        pre = document.createElement('pre');
        pre.id = 'boot-trace';
        pre.style.cssText =
          'margin:12px;padding:10px;border:1px solid #2d6a4f;border-radius:8px;background:#0d1a14;' +
          'color:#b7f5d8;font:11px/1.6 monospace;white-space:pre-wrap;';
        document.body.appendChild(pre);
      }
      pre.textContent = 'Boot trace\n' + global.__aggoraTrace!.join('\n');
    };
    if (document.body) {
      pintar();
    } else {
      document.addEventListener('DOMContentLoaded', pintar, { once: true });
    }
  }
}
