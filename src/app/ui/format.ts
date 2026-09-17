/**
 * Helpers de presentacion: formato de numeros y horas, recorte de etiquetas y la fila que
 * consumen las tablas de metricas.
 *
 * Viven fuera de los componentes porque los usan tanto las plantillas como los calculos.
 */

/**
 * Helpers de formato. Viven aqui y no en un pipe porque se usan tambien desde los componentes
 * (calculos) y desde las plantillas.
 */

/** Numero compacto y legible para la UI: 3 decimales si es pequeno, miles si es grande. */
export function formatNumber(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) {
    return '--';
  }
  const absoluto = Math.abs(valor);
  if (absoluto === 0) {
    return '0';
  }
  if (absoluto < 0.001) {
    return valor.toExponential(2);
  }
  if (absoluto < 1) {
    return valor.toFixed(4);
  }
  if (absoluto < 1000) {
    return valor.toFixed(absoluto < 10 ? 2 : 1);
  }
  return valor.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Offset/contador: entero con separador de miles. */
export function formatInteger(valor: number | null | undefined): string {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) {
    return '--';
  }
  return Math.round(valor).toLocaleString('en-US');
}

/** Hora local corta a partir de un ISO o de milisegundos. */
export function formatClock(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') {
    return '--';
  }
  const fecha = typeof valor === 'number' ? new Date(valor) : new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    return String(valor);
  }
  return fecha.toLocaleTimeString('en-GB', { hour12: false });
}

/** "hace 3 s" a partir de un instante en ms. */
export function formatAge(instante: number | null | undefined, ahora: number): string {
  if (!instante) {
    return 'never';
  }
  const segundos = Math.max(0, Math.round((ahora - instante) / 1000));
  if (segundos < 60) {
    return `${segundos}s ago`;
  }
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) {
    return `${minutos}m ago`;
  }
  return `${Math.floor(minutos / 60)}h ago`;
}

/** Etiqueta corta de una serie larga: "market.ticks.raw/3" -> "raw/3". */
export function shortLabel(label: string, max = 26): string {
  if (label.length <= max) {
    return label;
  }
  return `...${label.slice(label.length - max + 3)}`;
}

/** Suma o resta puntos de la ventana movil para graficas que quieren el incremento. */
export function deltas(valores: readonly number[]): number[] {
  const salida: number[] = [];
  for (let i = 1; i < valores.length; i += 1) {
    salida.push(valores[i] - valores[i - 1]);
  }
  return salida;
}

/** Lista de valores numericos de un estado de panel para una serie concreta. */
export function valoresDe(
  series: readonly { label: string; points: readonly (readonly [number, number])[] }[],
  label: string,
): number[] {
  const serie = series.find((candidata) => candidata.label === label);
  return serie ? serie.points.map((punto) => punto[1]) : [];
}

/** Lista compacta de filas label/valor para la UI. */
export interface MetricRow {
  readonly label: string;
  readonly value: number | null;
  readonly color: string;
  /** Texto de apoyo: por ejemplo, el motivo del DLT o el estado del target. */
  readonly hint?: string;
  /** Marca la fila como problema (rojo) o como aviso (ambar). */
  readonly tone?: 'ok' | 'warn' | 'bad' | 'muted';
}
