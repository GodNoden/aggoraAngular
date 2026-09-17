import {
  contractWarnings,
  lastTimestamp,
  lastValue,
  parseMetricsResponse,
} from './contract.parser';

/**
 * El catalogo de metricas es la mitad de la pagina que se pide por HTTP.
 *
 * Dos cosas que se fijan aqui y que son decisiones, no detalles:
 *
 *  1. Un panel con `series: []` **no es un error**: es "no hay dato", y la `nota` del backend es la
 *     que explica por que. La pagina no rellena nada.
 *  2. La app avisa cuando el backend no cumple su propia promesa (series y nota a la vez, o vacio sin
 *     nota). El encargo lo pedia explicitamente: si la documentacion y la respuesta real no cuadran,
 *     gana la respuesta real y hay que decirlo.
 */
describe('parseMetricsResponse', () => {
  const LAG = {
    panel: 'lag',
    ts: '2026-09-17T08:00:00.123Z',
    stack: 'spring',
    series: [{ label: 'ingestion-normalizer', points: [[1758096000, 0]] }],
  };

  it('acepta la forma del contrato', () => {
    const respuesta = parseMetricsResponse(LAG);
    expect(respuesta).not.toBeNull();
    expect(respuesta?.panel).toBe('lag');
    expect(respuesta?.stack).toBe('spring');
    expect(respuesta?.series.length).toBe(1);
    expect(respuesta?.series[0].label).toBe('ingestion-normalizer');
    expect(respuesta?.series[0].points[0]).toEqual([1758096000, 0]);
  });

  it('acepta un panel vacio con nota, que es el caso de transacciones', () => {
    const respuesta = parseMetricsResponse({
      panel: 'transacciones',
      ts: 'x',
      stack: 'quarkus',
      series: [],
      nota: 'Prometheus no publica confirmadas frente a abortadas',
    });
    expect(respuesta).not.toBeNull();
    expect(respuesta?.series.length).toBe(0);
    expect(respuesta?.nota).toContain('Prometheus');
  });

  it('acepta comparativa con su campo de', () => {
    const respuesta = parseMetricsResponse({
      panel: 'comparativa',
      de: 'lag',
      ts: 'x',
      stack: 'spring',
      series: [
        { label: 'spring/ingestion-normalizer', points: [[1, 0]] },
        { label: 'quarkus/ingestion-normalizer-q', points: [[1, 4]] },
      ],
    });
    expect(respuesta?.de).toBe('lag');
    expect(respuesta?.series.length).toBe(2);
  });

  it('acepta una serie con varios puntos: la forma ya lo admite', () => {
    const respuesta = parseMetricsResponse({
      panel: 'pulso',
      ts: 'x',
      stack: 'spring',
      series: [{ label: 'entrada', points: [[1, 10], [2, 20], [3, 30]] }],
    });
    expect(respuesta?.series[0].points.length).toBe(3);
    expect(lastValue(respuesta!.series[0])).toBe(30);
    expect(lastTimestamp(respuesta!.series[0])).toBe(3);
  });

  it('devuelve null cuando la forma no cuadra, en vez de lanzar', () => {
    expect(parseMetricsResponse(null)).toBeNull();
    expect(parseMetricsResponse('texto')).toBeNull();
    expect(parseMetricsResponse({})).toBeNull();
    expect(parseMetricsResponse({ panel: 'lag', ts: 'x', stack: 'spring' })).toBeNull();
    expect(
      parseMetricsResponse({ panel: 'lag', ts: 'x', stack: 'spring', series: 'nope' }),
    ).toBeNull();
    expect(
      parseMetricsResponse({
        panel: 'lag',
        ts: 'x',
        stack: 'spring',
        series: [{ label: 'a', points: [[1]] }],
      }),
    ).toBeNull();
    expect(
      parseMetricsResponse({
        panel: 'lag',
        ts: 'x',
        stack: 'spring',
        series: [{ label: 'a', points: [['x', 1]] }],
      }),
    ).toBeNull();
  });

  it('no lanza con JSON arbitrario', () => {
    const basura: unknown[] = [[], [1, 2], { series: [null] }, { series: [{}] }, 42, true];
    for (const crudo of basura) {
      expect(() => parseMetricsResponse(crudo)).not.toThrow();
    }
  });

  it('un lag negativo se conserva: el exporter puede dar -3 y es un dato real', () => {
    const respuesta = parseMetricsResponse({
      panel: 'lag',
      ts: 'x',
      stack: 'spring',
      series: [{ label: 'analytics-streams', points: [[1, -3]] }],
    });
    expect(lastValue(respuesta!.series[0])).toBe(-3);
  });

  it('lastValue es null con una serie sin puntos', () => {
    const respuesta = parseMetricsResponse({
      panel: 'lag',
      ts: 'x',
      stack: 'spring',
      series: [{ label: 'vacia', points: [] }],
    });
    expect(lastValue(respuesta!.series[0])).toBeNull();
    expect(lastTimestamp(respuesta!.series[0])).toBeNull();
  });
});

describe('contractWarnings', () => {
  const base = { panel: 'pulso', ts: 'x', stack: 'spring' as const, series: [] as const };

  it('no avisa de una respuesta vacia con nota: es exactamente lo que promete el contrato', () => {
    const avisos = contractWarnings({ ...base, nota: 'no hay serie' });
    expect(avisos).toEqual([]);
  });

  it('avisa si viene vacio SIN nota: el contrato pide explicar el hueco', () => {
    const avisos = contractWarnings({ ...base });
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toContain('sin nota');
  });

  it('avisa si vienen series Y nota a la vez', () => {
    const avisos = contractWarnings({
      ...base,
      series: [{ label: 'entrada', points: [[1, 2]] }],
      nota: 'esto no deberia estar aqui',
    });
    expect(avisos.some((aviso) => aviso.includes('series Y nota'))).toBeTrue();
  });

  it('avisa cuando una serie trae mas de un punto', () => {
    const avisos = contractWarnings({
      ...base,
      series: [{ label: 'entrada', points: [[1, 2], [2, 3]] }],
    });
    expect(avisos.some((aviso) => aviso.includes('mas de un punto'))).toBeTrue();
  });
});
