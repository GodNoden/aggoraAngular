/**
 * Las piezas que se repiten: una mini-grafica, una tarjeta con su explicacion y dos formateadores.
 *
 * Nada de libreria de graficas: una serie de menos de 60 numeros se pinta con un `polyline`. Que el
 * dibujo sea lo menos importante de la pagina es el objetivo, no una limitacion.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/* ------------------------------------------------------------------ formato */

/** Numero para leer de un vistazo: entero con separador de miles. */
export function entero(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) {
    return '--';
  }
  return Math.round(valor).toLocaleString('es-ES');
}

/** Numero con decimales utiles, sin mentir sobre la precision. */
export function numero(valor: number | null | undefined, decimales = 1): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) {
    return '--';
  }
  return valor.toLocaleString('es-ES', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

/** "hace 3 s", a partir de un instante en milisegundos. */
export function hace(instante: number | null | undefined, ahora: number): string {
  if (!instante) {
    return 'nunca';
  }
  const segundos = Math.max(0, Math.round((ahora - instante) / 1000));
  if (segundos < 60) {
    return `hace ${segundos} s`;
  }
  return `hace ${Math.floor(segundos / 60)} min`;
}

/** Etiqueta corta: los topics y particiones son largos y la tarjeta es estrecha. */
export function corto(label: string, max = 26): string {
  return label.length <= max ? label : `...${label.slice(label.length - max + 3)}`;
}

/* ------------------------------------------------------------------ grafica */

@Component({
  selector: 'ag-spark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" [attr.aria-label]="label()">
      @if (linea()) {
        <polyline class="area" [attr.points]="area()" [attr.fill]="color()" />
        <polyline class="line" [attr.points]="linea()" [attr.stroke]="color()" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }
    .spark {
      display: block;
      width: 100%;
      height: 26px;
      overflow: visible;
    }
    .line {
      fill: none;
      stroke-width: 1.6;
      stroke-linejoin: round;
      stroke-linecap: round;
      vector-effect: non-scaling-stroke;
    }
    .area {
      fill: currentColor;
      opacity: 0.12;
      stroke: none;
    }
  `,
})
export class Spark {
  /** Valores en orden temporal. */
  readonly values = input<readonly number[]>([]);
  readonly color = input('#3ddc97');
  readonly label = input('serie reciente');

  /** Puntos ya escalados al lienzo de 100x24. */
  private readonly puntos = computed<readonly (readonly [number, number])[]>(() => {
    const datos = this.values();
    if (datos.length === 0) {
      return [];
    }
    const min = Math.min(...datos);
    const max = Math.max(...datos);
    const span = max - min || 1;
    const paso = datos.length > 1 ? 100 / (datos.length - 1) : 0;
    return datos.map((valor, indice) => [
      datos.length > 1 ? indice * paso : 50,
      22 - ((valor - min) / span) * 20,
    ] as const);
  });

  readonly linea = computed(() =>
    this.puntos()
      .map(([x, y], indice) => `${indice === 0 ? '' : ' '}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(''),
  );

  /** La misma linea cerrada por abajo, para darle cuerpo. */
  readonly area = computed(() =>
    this.puntos().length === 0
      ? ''
      : `0,24 ${this.linea()} ${this.puntos()[this.puntos().length - 1][0].toFixed(2)},24`,
  );
}

/* ------------------------------------------------------------------ tarjeta */

/**
 * La tarjeta de un panel: el dato primero y su explicacion debajo.
 *
 * La explicacion se puede plegar (`?explicar=0`) para quien ya se la sabe y solo viene a mirar
 * numeros. Por defecto va abierta: esto es material para entender el backend.
 */
@Component({
  selector: 'ag-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="card" [attr.data-estado]="estado()">
      <header>
        <div class="titles">
          <h3>{{ title() }}</h3>
          <span class="ask">{{ ask() }}</span>
        </div>
        <div class="badges">
          <span class="badge" [attr.data-estado]="estado()">{{ etiqueta() }}</span>
          @if (ms() !== null) {
            <span class="badge muted">{{ ms() }} ms</span>
          }
        </div>
      </header>

      <div class="body"><ng-content /></div>

      @if (note()) {
        <p class="note" [attr.data-estado]="estado()">{{ note() }}</p>
      }

      @if (abierta()) {
        <dl class="doc">
          <dt>Que estas viendo</dt>
          <dd>{{ queVes() }}</dd>
          <dt>Por que importa</dt>
          <dd>{{ porQue() }}</dd>
          <dt>Si esta sano</dt>
          <dd>{{ normal() }}</dd>
          <dt>Si se rompe</dt>
          <dd>{{ roto() }}</dd>
          @if (lesson(); as leccion) {
            <dt>Para verlo romperse</dt>
            <dd class="lesson">
              <code>{{ leccion.command }}</code>
              <span>{{ leccion.does }}</span>
              <em>{{ leccion.expect }}</em>
            </dd>
          }
        </dl>
      }
    </article>
  `,
  styles: `
    :host {
      display: flex;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      background: var(--panel);
      border: 1px solid var(--linea);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .card[data-estado='error'] {
      border-color: color-mix(in srgb, var(--roto) 45%, var(--linea));
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
      min-width: 0;
    }
    h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
      color: var(--tinta);
    }
    .ask {
      font-size: 10.5px;
      color: var(--tinta-suave);
      font-family: var(--mono);
    }
    .badges {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .badge {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--linea);
      color: var(--tinta-suave);
      white-space: nowrap;
    }
    .badge[data-estado='ok'] {
      color: var(--bien);
      border-color: color-mix(in srgb, var(--bien) 40%, var(--linea));
    }
    .badge[data-estado='vacio'] {
      color: var(--info);
      border-color: color-mix(in srgb, var(--info) 40%, var(--linea));
    }
    .badge[data-estado='error'] {
      color: var(--roto);
      border-color: color-mix(in srgb, var(--roto) 45%, var(--linea));
    }
    .badge[data-estado='pidiendo'] {
      color: var(--aviso);
    }
    .body {
      flex: 1 1 auto;
      min-height: 0;
    }
    .note {
      margin: 0;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--tinta-suave);
      border-left: 2px solid var(--info);
      background: color-mix(in srgb, var(--info) 8%, transparent);
      padding: 6px 8px;
      border-radius: 4px;
    }
    .note[data-estado='error'] {
      color: var(--roto);
      border-left-color: var(--roto);
      background: color-mix(in srgb, var(--roto) 8%, transparent);
    }
    .doc {
      margin: 2px 0 0;
      padding-top: 8px;
      border-top: 1px dashed var(--linea);
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      font-size: 11.5px;
      line-height: 1.45;
    }
    dt {
      color: var(--tinta-tenue);
      white-space: nowrap;
    }
    dd {
      margin: 0;
      color: var(--tinta-suave);
    }
    dd.lesson {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 3px;
    }
    dd.lesson code {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--tinta);
      background: var(--panel-2);
      border: 1px solid var(--linea);
      border-radius: 4px;
      padding: 3px 6px;
      align-self: flex-start;
    }
    dd.lesson em {
      color: var(--aviso);
      font-style: normal;
    }
  `,
})
export class Card {
  readonly title = input.required<string>();
  readonly ask = input('');
  readonly estado = input<'pidiendo' | 'ok' | 'vacio' | 'error'>('pidiendo');
  readonly ms = input<number | null>(null);
  readonly note = input<string | null>(null);
  readonly abierta = input(true);
  readonly queVes = input('');
  readonly porQue = input('');
  readonly normal = input('');
  readonly roto = input('');
  readonly lesson = input<{ command: string; does: string; expect: string } | null>(null);

  protected readonly etiqueta = computed(() => {
    switch (this.estado()) {
      case 'ok':
        return 'con datos';
      case 'vacio':
        return 'vacio a proposito';
      case 'error':
        return 'error';
      default:
        return 'pidiendo';
    }
  });
}
