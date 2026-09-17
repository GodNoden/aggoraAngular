/**
 * La pagina. Todo lo que se ve esta aqui, salvo las piezas repetidas (`ui/pieces.ts`) y el texto
 * explicativo (`ui/docs.ts`).
 *
 * La idea de la que sale todo lo demas: **cada panel responde a una pregunta sobre el backend**, y
 * al lado del dato esta la explicacion de que se esta viendo y que significa que se rompa. Los
 * numeros son la evidencia; el texto es el producto.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Catalog, PanelName, COMPARABLES } from './core/catalog';
import { LiveFeed } from './core/live';
import { Analytics } from './core/analytics';
import { PanelData, Series, STACK_LABEL, STACKS, Stack, View, find, value } from './core/types';
import { Card, Spark, corto, entero, hace, numero } from './ui/pieces';
import { COMPARISON, DOCS } from './ui/docs';

/** Un stack en pantalla: el que se esta mirando, o los dos en el modo lado a lado. */
interface Column {
  readonly stack: Stack;
  readonly label: string;
}

/** Una fila de una lista de metricas. */
interface Row {
  readonly label: string;
  readonly valor: number | null;
  readonly tone: 'ok' | 'aviso' | 'roto' | 'tenue';
  readonly hint?: string;
}

/** Un grupo del panel de salud. */
interface HealthGroup {
  readonly key: string;
  readonly title: string;
  readonly items: readonly Row[];
  readonly cuenta: string;
}

@Component({
  selector: 'aggora-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Card, Spark],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  private readonly catalog = inject(Catalog);
  private readonly live = inject(LiveFeed);
  private readonly analytics = inject(Analytics);

  /** Lo que elige el usuario. */
  protected readonly view = signal<View>('spring');
  protected readonly comparado = this.catalog.comparado;
  protected readonly comparables = COMPARABLES;
  protected readonly docs = DOCS;
  protected readonly comparison = COMPARISON;
  protected readonly simbolo = signal('EUR/USD');
  protected readonly minutos = signal(3);

  /** Reloj de la pantalla: las edades ("hace 3 s") se repintan sin volver a pedir nada. */
  private readonly reloj = signal(Date.now());
  private readonly latido = setInterval(() => this.reloj.set(Date.now()), 1000);
  protected readonly ahora = this.reloj.asReadonly();

  /** La explicacion de cada panel se puede plegar con `?explicar=0`. */
  protected readonly explicar =
    typeof location === 'undefined' || new URLSearchParams(location.search).get('explicar') !== '0';

  /** Las columnas visibles: una sola, o las dos para comparar. */
  protected readonly columnas = computed<readonly Column[]>(() => {
    const modo = this.view();
    const stacks = modo === 'both' ? STACKS : [modo];
    return stacks.map((stack) => ({ stack, label: STACK_LABEL[stack] }));
  });

  protected readonly ambos = computed(() => this.view() === 'both');

  /**
   * El diagrama del pipeline: cinco cajas que se encienden segun lo que dice el catalogo.
   *
   * Es la parte que contesta "que esta haciendo el backend ahora mismo" de un vistazo. El color no es
   * decoracion: cada caja mira el dato que le corresponde y se pone en rojo sola.
   */
  protected readonly etapas = computed(() => {
    const stack: Stack = this.view() === 'quarkus' ? 'quarkus' : 'spring';
    const pulso = this.series('pulso', stack);
    const entrando = value(find(pulso, 'entrada'));
    const saliendo = value(find(pulso, stack === 'quarkus' ? 'salida-quarkus' : 'salida-spring'));
    const lagMaximo = Math.max(
      0,
      ...this.series('lag', stack).map((serie) => value(serie) ?? 0),
    );
    const descartes = this.series('descartes', stack).reduce(
      (suma, serie) => suma + (value(serie) ?? 0),
      0,
    );
    const salud = this.series('salud', stack);
    const motor = salud.find((serie) => serie.label.startsWith(stack));
    const motorCaido = motor ? (value(motor) ?? 1) < 1 : false;
    const infrarreplicadas = salud.filter(
      (serie) => serie.label.startsWith('under-replicated/') && (value(serie) ?? 0) > 0,
    ).length;
    const socket = this.live.state()[stack].state;
    const aviso = 'aviso' as const;
    return [
      {
        key: 'simulador',
        icono: '📈',
        nombre: 'Simulador de mercado',
        que: 'Genera ticks sinteticos, con precio y tamano, como si fueran de un mercado real.',
        donde: 'el latido',
        tone: entrando === null ? 'tenue' : entrando > 0 ? 'ok' : aviso,
      },
      {
        key: 'kafka',
        icono: '🗂️',
        nombre: 'Kafka: market.ticks.raw',
        que: 'Los ticks se guardan en un log particionado por donde los leen los dos stacks.',
        donde: 'particiones',
        tone: (entrando ?? 0) > 0 ? 'ok' : 'tenue',
      },
      {
        key: 'normalizador',
        icono: '🧮',
        nombre: 'Normalizador',
        que: 'Valida y convierte cada tick al formato canonico; lo que no puede procesar va a la DLT.',
        donde: 'descartes',
        tone: descartes > 0 ? aviso : saliendo !== null && saliendo > 0 ? 'ok' : aviso,
      },
      {
        key: 'streams',
        icono: '🌊',
        nombre: 'Motor de streams',
        que: 'Calcula ventanas: VWAP, media movil, volatilidad, y las deja en su state store.',
        donde: 'salud',
        tone: motorCaido ? 'roto' : 'ok',
      },
      {
        key: 'prometheus',
        icono: '📊',
        nombre: 'Prometheus y gateways',
        que: 'Recoge las metricas de todo lo anterior y las publica por HTTP y por WebSocket.',
        donde: 'el catalogo entero',
        tone: socket === 'abierto' ? 'ok' : aviso,
      },
    ];
  });

  /** El estado en vivo de un stack. */
  protected vivo(stack: Stack) {
    return this.live.state()[stack];
  }

  /** Como esta el socket de un stack, en una frase. */
  protected estadoSocket(stack: Stack): string {
    const estado = this.vivo(stack);
    switch (estado.state) {
      case 'abierto':
        return estado.lastAt
          ? `conectado, ultimo mensaje ${hace(estado.lastAt, this.ahora())}`
          : 'conectado, esperando la primera foto';
      case 'conectando':
        return 'conectando...';
      case 'reintentando':
        return `reintentando (intento ${estado.intentos})`;
      default:
        return 'parado';
    }
  }

  /** El estado de un panel del catalogo, en un stack. */
  protected panel(panel: string, stack: Stack) {
    return this.catalog.entry(panel, stack);
  }

  /** Datos de un panel, o lista vacia. */
  private series(panel: string, stack: Stack): readonly Series[] {
    return this.catalog.entry(panel, stack).data?.series ?? [];
  }

  protected valorDe(panel: string, stack: Stack, label: string): number | null {
    return value(find(this.series(panel, stack), label));
  }

  /** Ventana corta guardada de una serie, para la mini-grafica. */
  protected historia(panel: string, stack: Stack, label: string): readonly number[] {
    return this.catalog.serie(panel, stack, label);
  }

  /* ---------------------------------------------------------------- paneles */

  /** `pulso`: las tasas del catalogo, con su color fijo. */
  protected tasasPulso(stack: Stack): readonly Row[] {
    const colores: Record<string, string> = {
      entrada: 'var(--bien)',
      'salida-spring': 'var(--aviso)',
      'salida-quarkus': 'var(--info)',
    };
    return this.series('pulso', stack).map((serie) => ({
      label: serie.label,
      valor: value(serie),
      tone: 'ok' as const,
      hint: colores[serie.label] ?? 'var(--info)',
    }));
  }

  /** `lag`: un grupo de consumidores por fila. */
  protected filasLag(stack: Stack): readonly Row[] {
    return this.series('lag', stack).map((serie) => {
      const dato = value(serie);
      return {
        label: serie.label,
        valor: dato,
        tone:
          dato === null
            ? ('tenue' as const)
            : dato > 500
              ? ('roto' as const)
              : dato > 50
                ? ('aviso' as const)
                : ('ok' as const),
      };
    });
  }

  /** `particiones`: el offset de cada particion, ordenado por topic. */
  protected filasParticiones(stack: Stack): readonly Row[] {
    return [...this.series('particiones', stack)]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((serie) => ({ label: serie.label, valor: value(serie), tone: 'ok' as const }));
  }

  /** `descartes`: lo que no es cero primero, porque es lo unico que hay que mirar. */
  protected filasDescartes(stack: Stack): readonly Row[] {
    return [...this.series('descartes', stack)]
      .sort((a, b) => (value(b) ?? 0) - (value(a) ?? 0))
      .map((serie) => {
        const dato = value(serie);
        return {
          label: serie.label,
          valor: dato,
          tone: (dato ?? 0) > 0 ? ('roto' as const) : ('tenue' as const),
          hint:
            (dato ?? 0) > 0
              ? 'aqui si hay mensajes: el motivo viaja en la cabecera x-dlt-reason del propio mensaje'
              : undefined,
        };
      });
  }

  /** `salud`: las tres comprobaciones que el contrato mete en el mismo panel. */
  protected gruposSalud(stack: Stack): readonly HealthGroup[] {
    const series = this.series('salud', stack);
    const esIsr = (label: string) => label.startsWith('under-replicated/');
    const objetivo = (label: string) => !esIsr(label) && !label.includes('/');
    const motor = (label: string) => !esIsr(label) && label.includes('/');
    const isrCero = series.filter((serie) => esIsr(serie.label) && (value(serie) ?? 0) === 0);
    const isrMal = series.filter((serie) => esIsr(serie.label) && (value(serie) ?? 0) > 0);

    const fila = (serie: Series): Row => {
      const dato = value(serie);
      return {
        label: serie.label,
        valor: dato,
        tone: dato === null ? 'tenue' : dato >= 1 ? 'ok' : 'roto',
      };
    };
    const targets = series.filter((serie) => objetivo(serie.label));
    const motores = series.filter((serie) => motor(serie.label));

    const grupos: HealthGroup[] = [
      {
        key: 'targets',
        title: 'Targets que Prometheus consigue sondear',
        items: targets.map(fila),
        cuenta: `${targets.filter((serie) => (value(serie) ?? 1) < 1).length} en 0`,
      },
      {
        key: 'motores',
        title: 'Motor de Kafka Streams de cada stack',
        items: motores.map(fila),
        cuenta: `${motores.filter((serie) => (value(serie) ?? 1) < 1).length} en 0`,
      },
      {
        key: 'isr',
        title: 'Particiones con menos copias de las que deberian',
        items: isrMal.map((serie) => ({
          label: serie.label,
          valor: value(serie),
          tone: 'roto' as const,
        })),
        cuenta:
          isrCero.length > 0
            ? `${isrMal.length} por encima de 0 · ${isrCero.length} en 0 (plegadas)`
            : 'ninguna',
      },
    ];
    return grupos.filter((grupo) => grupo.items.length > 0);
  }

  /** El veredicto de salud, en una frase. */
  protected veredictoSalud(stack: Stack): { tone: string; texto: string } {
    const series = this.series('salud', stack);
    if (series.length === 0) {
      return { tone: 'tenue', texto: 'sin datos todavia' };
    }
    const mal = series.filter((serie) => {
      const dato = value(serie);
      return serie.label.startsWith('under-replicated/') ? (dato ?? 0) > 0 : (dato ?? 1) < 1;
    });
    if (mal.length === 0) {
      return { tone: 'ok', texto: 'todo lo que el catalogo puede ver esta en pie' };
    }
    return {
      tone: 'roto',
      texto: `${mal.length} comprobaciones en rojo: ${mal
        .slice(0, 3)
        .map((serie) => corto(serie.label, 30))
        .join(', ')}`,
    };
  }

  /* ---------------------------------------------------------------- en vivo */

  /** Cuantas fotos por segundo han llegado entre los dos stacks. */
  protected readonly fotos = computed(() =>
    STACKS.reduce((total, stack) => total + (this.live.state()[stack].counters['snapshot'] ?? 0), 0),
  );

  /** La ultima foto recibida por WebSocket. */
  protected foto(stack: Stack) {
    return this.vivo(stack).snapshot;
  }

  /** La tasa de entrada de la ventana del WebSocket. */
  protected ventanaIn(stack: Stack): readonly number[] {
    return this.vivo(stack).window.map(([entran]) => entran);
  }

  /** Los simbolos de la ultima foto, el mas viejo primero: asi se ve el que se paro. */
  protected simbolos(
    stack: Stack,
  ): readonly { symbol: string; price: string; source: string; age: number }[] {
    const foto = this.foto(stack);
    if (!foto) {
      return [];
    }
    return Object.entries(foto.symbols)
      .map(([symbol, tick]) => ({
        symbol,
        price: tick.price,
        source: tick.source,
        age: Date.parse(tick.at) || 0,
      }))
      .sort((a, b) => a.age - b.age)
      .slice(0, 12);
  }

  /* ---------------------------------------------------------------- comparacion */

  protected filasComparativa(stack: Stack): readonly Row[] {
    const datos: PanelData | null = this.catalog.entry('comparativa', stack).data;
    return (datos?.series ?? []).map((serie) => ({
      label: serie.label,
      valor: value(serie),
      tone: 'ok' as const,
      hint: serie.label.startsWith('quarkus') ? 'var(--info)' : 'var(--bien)',
    }));
  }

  /* ---------------------------------------------------------------- acciones */

  protected cambiarVista(modo: View): void {
    this.view.set(modo);
    void this.catalog.refresh();
  }

  protected elegirComparado(panel: string): void {
    this.catalog.comparado.set(panel);
    void this.catalog.refresh();
  }

  protected consultar(): void {
    void this.analytics.query('spring', this.simbolo(), this.minutos());
  }

  protected readonly analitica = this.analytics.state;

  protected tiempoRelativo(instante: number | null): string {
    return hace(instante, this.ahora());
  }

  constructor() {
    this.live.start();
    this.catalog.start();
    this.consultar();
  }

  ngOnDestroy(): void {
    // En los tests el componente si se destruye: sin esto, los intervalos dejan Karma colgado.
    clearInterval(this.latido);
    this.live.stop();
    this.catalog.stop();
  }

  /* Atajos que usan las plantillas. */
  protected readonly formatEntero = entero;
  protected readonly formatNumero = numero;
  protected readonly formatCorto = corto;
  protected readonly paneles: readonly PanelName[] = ['pulso', 'lag', 'particiones', 'descartes', 'salud', 'transacciones'];
}
