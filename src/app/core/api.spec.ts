import { analyticsUrl, catalogUrl, parseFrame, parsePanel, parseWindows, socketUrl } from './api';

/** Lo que el backend manda de verdad, recortado. */
const FOTO = JSON.stringify({
  v: 1,
  kind: 'snapshot',
  stack: 'spring',
  ts: '2026-09-17T16:00:00Z',
  ticksIn: 35,
  ticksOut: 7,
  symbols: { 'EUR/USD': { price: '1.1509', currency: 'USD', size: 166, source: 'SYNTHETIC', at: '2026-09-17T16:00:00Z' } },
});

describe('parseFrame', () => {
  it('lee una foto por segundo', () => {
    const frame = parseFrame(FOTO);
    expect(frame?.kind).toBe('snapshot');
    if (frame?.kind === 'snapshot') {
      expect(frame.snapshot.ticksIn).toBe(35);
      expect(frame.snapshot.ticksOut).toBe(7);
      expect(frame.snapshot.symbols['EUR/USD'].price).toBe('1.1509');
    }
  });

  it('lee una posicion con el dinero como texto', () => {
    const frame = parseFrame(
      JSON.stringify({
        v: 1, kind: 'position', stack: 'spring', ts: 'x', account: 'A-1', symbol: 'EUR/USD',
        quantity: 1000, averageCost: '1.1500', realizedPnl: '-2.50', exposure: '1150.00',
        currency: 'USD', marginBreach: true,
      }),
    );
    expect(frame?.kind).toBe('position');
    if (frame?.kind === 'position') {
      expect(frame.position.averageCost).toBe('1.1500');
      expect(frame.position.marginBreach).toBe(true);
    }
  });

  it('normaliza una gravedad desconocida en vez de perder la alerta', () => {
    const frame = parseFrame(
      JSON.stringify({ v: 1, kind: 'alert', stack: 'quarkus', ts: 'x', severity: 'NUEVA', type: 't', subject: 's', detail: 'd', value: 'v' }),
    );
    expect(frame?.kind).toBe('alert');
    if (frame?.kind === 'alert') {
      expect(frame.alert.severity).toBe('INFO');
    }
  });

  it('rechaza lo que no sigue el contrato sin lanzar', () => {
    expect(parseFrame('no es json')).toBeNull();
    expect(parseFrame('{}')).toBeNull();
    // Falta ticksIn: la foto no sirve.
    expect(parseFrame(JSON.stringify({ kind: 'snapshot', stack: 'spring', ts: 'x', ticksOut: 1 }))).toBeNull();
    // Un tipo que no existe.
    expect(parseFrame(JSON.stringify({ kind: 'loquesea', stack: 'spring', ts: 'x' }))).toBeNull();
  });
});

describe('parsePanel', () => {
  it('lee el catalogo con su nota', () => {
    const datos = parsePanel(
      { panel: 'transacciones', ts: 'x', stack: 'spring', series: [], nota: 'esa metrica no existe aqui' },
      'transacciones',
      'spring',
    );
    expect(datos?.series).toEqual([]);
    expect(datos?.nota).toBe('esa metrica no existe aqui');
  });

  it('lee series con un punto y admite varias puntos', () => {
    const datos = parsePanel(
      { panel: 'pulso', ts: 'x', stack: 'spring', series: [{ label: 'entrada', points: [[1, 2], [2, 3]] }] },
      'pulso',
      'spring',
    );
    expect(datos?.series[0].points.length).toBe(2);
  });

  it('descarta series rotas en vez de aceptar basura', () => {
    const datos = parsePanel(
      { panel: 'lag', ts: 'x', stack: 'spring', series: [{ points: [[1, 2]] }, { label: 'buena', points: [['a', 'b'], [3, 4]] }] },
      'lag',
      'spring',
    );
    expect(datos?.series.length).toBe(1);
    expect(datos?.series[0].label).toBe('buena');
    expect(datos?.series[0].points).toEqual([[3, 4]]);
  });

  it('devuelve null si no es la forma del contrato', () => {
    expect(parsePanel({ algo: 'otra cosa' }, 'pulso', 'spring')).toBeNull();
    expect(parsePanel('texto', 'pulso', 'spring')).toBeNull();
  });
});

describe('parseWindows', () => {
  it('acepta la lista real del state store', () => {
    const ventanas = parseWindows([
      { symbol: 'EUR/USD', currency: 'USD', windowKind: 'TUMBLING', windowStart: 'a', windowEnd: 'b', ticks: 89, volume: 22106, vwap: 1.1551, movingAverage: 1.155, volatility: 0.0033, lastPrice: 1.1515 },
    ]);
    expect(ventanas.length).toBe(1);
    expect(ventanas[0].vwap).toBe(1.1551);
  });

  it('tolera un objeto con windows y descarta lo que no trae simbolo', () => {
    expect(parseWindows({ windows: [{ symbol: 'EUR/USD' }, { sin: 'simbolo' }] }).length).toBe(1);
    expect(parseWindows('nada')).toEqual([]);
  });
});

describe('socketUrl', () => {
  it('usa el host de la pagina y ws:// en http', () => {
    expect(socketUrl('spring')).toBe('ws://localhost:9876/ws');
    expect(socketUrl('quarkus')).toBe('ws://localhost:9876/q/ws');
  });
});

describe('las URLs del backend', () => {
  it('no duplica la ruta de analytics: ya paso y salia un 404', () => {
    expect(analyticsUrl('spring', 'EUR/USD', 3)).toBe('/analytics?symbol=EUR%2FUSD&minutes=3');
  });

  it('cada stack tiene su propio camino de analitica', () => {
    // La de Quarkus no esta en su gateway (8189) sino en su servicio de analitica (8185), y por eso
    // tiene prefijo propio en el proxy.
    expect(analyticsUrl('quarkus', 'EUR/USD', 3)).toBe('/q/analytics?symbol=EUR%2FUSD&minutes=3');
  });

  it('pide el catalogo una vez por panel', () => {
    expect(catalogUrl('spring', 'pulso')).toBe('/api/metrics?panel=pulso');
    expect(catalogUrl('quarkus', 'pulso')).toBe('/q/api/metrics?panel=pulso');
    expect(catalogUrl('spring', 'comparativa', 'lag')).toBe('/api/metrics?panel=comparativa&de=lag');
  });
});
