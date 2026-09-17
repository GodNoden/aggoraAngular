import { parseAnalytics } from './analytics.service';

/**
 * La consulta interactiva (`GET /analytics`).
 *
 * Ojo con la forma real: el backend devuelve una **lista** de ventanas, no un objeto. El contrato
 * documenta la URL pero no esta forma, asi que se comprobo contra el backend en marcha y estos tests
 * fijan lo que de verdad llega. Esa es la regla acordada: si la documentacion y la respuesta real no
 * coinciden, gana la respuesta real.
 */
describe('parseAnalytics', () => {
  const VENTANA = {
    symbol: 'EUR/USD',
    currency: 'USD',
    windowKind: 'TUMBLING',
    windowStart: '2026-09-17T09:26:00Z',
    windowEnd: '2026-09-17T09:26:30Z',
    ticks: 154,
    volume: 38385,
    vwap: 1.1507,
    movingAverage: 1.1507,
    volatility: 0.0023,
    lastPrice: 1.1505,
  };

  it('acepta la lista de ventanas que devuelve el backend', () => {
    const ventanas = parseAnalytics([VENTANA, { ...VENTANA, windowStart: 'otra' }]);
    expect(ventanas.length).toBe(2);
    expect(ventanas[0].symbol).toBe('EUR/USD');
    expect(ventanas[0].vwap).toBe(1.1507);
    expect(ventanas[0].ticks).toBe(154);
    expect(ventanas[0].windowKind).toBe('TUMBLING');
  });

  it('acepta tambien un objeto con windows, por tolerancia', () => {
    const ventanas = parseAnalytics({ windows: [VENTANA] });
    expect(ventanas.length).toBe(1);
  });

  it('devuelve lista vacia con basura, sin lanzar', () => {
    const basura: unknown[] = [null, undefined, 42, 'texto', {}, [], [null], [{}], [{ symbol: 7 }]];
    for (const crudo of basura) {
      expect(() => parseAnalytics(crudo)).not.toThrow();
    }
    expect(parseAnalytics(null).length).toBe(0);
    expect(parseAnalytics([{}]).length).toBe(0);
  });

  it('rellena con ceros los campos numericos que falten, sin inventar texto', () => {
    const ventanas = parseAnalytics([{ symbol: 'X' }]);
    expect(ventanas.length).toBe(1);
    expect(ventanas[0].vwap).toBe(0);
    expect(ventanas[0].currency).toBe('');
    expect(ventanas[0].windowStart).toBe('');
  });
});
