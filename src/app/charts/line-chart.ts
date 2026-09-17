import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Grafica de linea de la ventana movil: SVG a mano, sin librerias ni CDN.
 *
 * Por que a mano: una dependencia de CDN es una demo que un dia no carga, y para pintar 60 puntos
 * de una serie no hace falta nada mas que un `polyline`. El eje X es el indice del punto (un
 * snapshot por segundo), no la hora: lo que importa es la forma reciente, no la fecha exacta.
 */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="chart"
      [attr.viewBox]="viewBox()"
      preserveAspectRatio="none"
      role="img"
      [attr.aria-label]="ariaLabel()"
    >
      @if (paths().area) {
        <path class="area" [attr.d]="paths().area" [attr.fill]="color()" />
      }
      @if (zeroY(); as zy) {
        <line class="zero" x1="0" [attr.y1]="zy" [attr.x2]="width()" [attr.y2]="zy" />
      }
      @if (paths().line) {
        <path class="line" [attr.d]="paths().line" [attr.stroke]="color()" />
      }
      @if (lastPoint(); as punto) {
        <circle class="dot" [attr.cx]="punto[0]" [attr.cy]="punto[1]" r="2.5" [attr.fill]="color()" />
      }
      @if (values().length === 0) {
        <line class="empty-rule" x1="0" [attr.y1]="height() / 2" [attr.x2]="width()" [attr.y2]="height() / 2" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
    }
    .chart {
      display: block;
      width: 100%;
      height: var(--chart-height, 64px);
      overflow: visible;
    }
    .line {
      fill: none;
      stroke-width: 1.75;
      stroke-linejoin: round;
      stroke-linecap: round;
      vector-effect: non-scaling-stroke;
    }
    .area {
      opacity: 0.12;
      stroke: none;
    }
    .zero {
      stroke: #3a4356;
      stroke-width: 1;
      stroke-dasharray: 3 3;
      vector-effect: non-scaling-stroke;
    }
    .empty-rule {
      stroke: #2b3242;
      stroke-width: 1;
      stroke-dasharray: 4 4;
      vector-effect: non-scaling-stroke;
    }
    .dot {
      stroke: #0f1420;
      stroke-width: 1;
    }
  `,
})
export class LineChart {
  /** Valores a pintar, en orden temporal. */
  readonly values = input<readonly number[]>([]);
  readonly color = input('#3ddc97');
  readonly width = input(240);
  readonly height = input(64);
  readonly ariaLabel = input('moving window chart');
  /** Fuerza que el cero entre en la escala (util en lag y descartes, donde el cero es la buena noticia). */
  readonly includeZero = input(false);

  readonly viewBox = computed(() => `0 0 ${this.width()} ${this.height()}`);

  private readonly escala = computed(() => {
    const datos = this.values();
    if (datos.length === 0) {
      return { min: 0, max: 1, span: 1 };
    }
    let min = Math.min(...datos);
    let max = Math.max(...datos);
    if (this.includeZero()) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (min === max) {
      // Serie plana: se le da aire para que se vea en el centro y no pegada al borde.
      const margen = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
      min -= margen;
      max += margen;
    }
    return { min, max, span: max - min };
  });

  private readonly puntos = computed<readonly (readonly [number, number])[]>(() => {
    const datos = this.values();
    const { min, span } = this.escala();
    const ancho = this.width();
    const alto = this.height();
    if (datos.length === 0) {
      return [];
    }
    const paso = datos.length > 1 ? ancho / (datos.length - 1) : 0;
    return datos.map((valor, indice) => {
      const x = datos.length > 1 ? indice * paso : ancho / 2;
      const y = alto - ((valor - min) / span) * alto;
      return [redondear(x), redondear(y)] as const;
    });
  });

  readonly paths = computed(() => {
    const puntos = this.puntos();
    if (puntos.length === 0) {
      return { line: '', area: '' };
    }
    const alto = this.height();
    const linea = puntos.map(([x, y], indice) => `${indice === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
    const primera = puntos[0];
    const ultima = puntos[puntos.length - 1];
    const area = `${linea} L${ultima[0]},${alto} L${primera[0]},${alto} Z`;
    return { line: linea, area };
  });

  readonly lastPoint = computed(() => this.puntos().at(-1) ?? null);

  /** Posicion Y del cero, solo si el cero cae dentro de la escala. */
  readonly zeroY = computed(() => {
    const { min, max, span } = this.escala();
    if (min > 0 || max < 0) {
      return null;
    }
    return redondear(this.height() - ((0 - min) / span) * this.height());
  });
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}
