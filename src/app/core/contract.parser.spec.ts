import { parseLiveMessage } from './contract.parser';

/**
 * El parseo del contrato tiene un trabajo y es no romper la pagina.
 *
 * El WebSocket es un fan-out sin reenvio: si un frame raro tumbara la app, el usuario se quedaria
 * mirando una pantalla muerta justo cuando algo va mal. Estos tests fijan ese comportamiento: un
 * frame invalido se convierte en un fallo explicado, nunca en una excepcion.
 */
describe('parseLiveMessage', () => {
  const SNAPSHOT = JSON.stringify({
    v: 1,
    kind: 'snapshot',
    stack: 'spring',
    ts: '2026-09-17T08:00:00.123Z',
    ticksIn: 84,
    ticksOut: 12,
    symbols: {
      'EUR/USD': {
        price: '1.0875',
        currency: 'USD',
        size: 100,
        source: 'REFERENCE',
        at: '2026-09-17T08:00:00.100Z',
      },
    },
  });

  it('acepta un snapshot del contrato', () => {
    const resultado = parseLiveMessage(SNAPSHOT);
    expect(resultado.ok).toBeTrue();
    if (!resultado.ok) {
      return;
    }
    const mensaje = resultado.message;
    expect(mensaje.kind).toBe('snapshot');
    if (mensaje.kind !== 'snapshot') {
      return;
    }
    expect(mensaje.v).toBe(1);
    expect(mensaje.stack).toBe('spring');
    expect(mensaje.ticksIn).toBe(84);
    expect(mensaje.ticksOut).toBe(12);
    // El precio viaja como texto porque es un decimal de Avro: en dinero no se usa coma flotante.
    expect(mensaje.symbols['EUR/USD'].price).toBe('1.0875');
    expect(mensaje.symbols['EUR/USD'].size).toBe(100);
  });

  it('acepta un snapshot con symbols vacio', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'snapshot',
      stack: 'quarkus',
      ts: '2026-09-17T08:00:00.123Z',
      ticksIn: 0,
      ticksOut: 0,
      symbols: {},
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeTrue();
    if (resultado.ok && resultado.message.kind === 'snapshot') {
      expect(Object.keys(resultado.message.symbols).length).toBe(0);
    }
  });

  it('marca como fallo un frame que no es JSON en vez de lanzar', () => {
    const resultado = parseLiveMessage('<html>502 Bad Gateway</html>');
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('JSON');
      // El frame crudo se guarda recortado para poder ensenarlo en la UI.
      expect(resultado.raw.length).toBeGreaterThan(0);
    }
  });

  it('rechaza un snapshot sin ticksIn y dice que campo fallo', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'snapshot',
      stack: 'spring',
      ts: '2026-09-17T08:00:00.123Z',
      ticksOut: 12,
      symbols: {},
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('ticksIn');
    }
  });

  it('rechaza un snapshot cuyo symbols no es un objeto', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'snapshot',
      stack: 'spring',
      ts: '2026-09-17T08:00:00.123Z',
      ticksIn: 1,
      ticksOut: 1,
      symbols: [{ price: '1' }],
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('symbols');
    }
  });

  it('rechaza un tick cuyo price no es texto', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'snapshot',
      stack: 'spring',
      ts: '2026-09-17T08:00:00.123Z',
      ticksIn: 1,
      ticksOut: 1,
      symbols: {
        'EUR/USD': { price: 1.0875, currency: 'USD', size: 1, source: 'X', at: 'Y' },
      },
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('EUR/USD');
      expect(resultado.reason).toContain('price');
    }
  });

  it('rechaza un stack desconocido', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'snapshot',
      stack: 'kotlin',
      ts: 'x',
      ticksIn: 1,
      ticksOut: 1,
      symbols: {},
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('stack');
    }
  });

  it('rechaza un kind desconocido', () => {
    const crudo = JSON.stringify({ v: 1, kind: 'telemetry', stack: 'spring', ts: 'x' });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('kind');
    }
  });

  it('acepta position con los decimales como texto', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'position',
      stack: 'spring',
      ts: '2026-09-17T08:00:00Z',
      account: 'ACC-1',
      symbol: 'AAPL',
      quantity: 100,
      averageCost: '333.47',
      realizedPnl: '0',
      exposure: '33347',
      currency: 'USD',
      marginBreach: false,
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeTrue();
    if (resultado.ok && resultado.message.kind === 'position') {
      expect(resultado.message.account).toBe('ACC-1');
      expect(resultado.message.averageCost).toBe('333.47');
      expect(resultado.message.marginBreach).toBeFalse();
    }
  });

  it('rechaza position con marginBreach no booleano', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'position',
      stack: 'spring',
      ts: 'x',
      account: 'A',
      symbol: 'B',
      quantity: 1,
      averageCost: '1',
      realizedPnl: '0',
      exposure: '1',
      currency: 'USD',
      marginBreach: 'no',
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeFalse();
    if (!resultado.ok) {
      expect(resultado.reason).toContain('marginBreach');
    }
  });

  it('acepta alert con severidad conocida', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'alert',
      stack: 'spring',
      ts: '2026-09-17T08:00:00Z',
      severity: 'CRITICAL',
      type: 'VOLATILITY_SPIKE',
      subject: 'ASML',
      detail: '...',
      value: '0.0123',
      raisedAt: '2026-09-17T08:00:00Z',
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeTrue();
    if (resultado.ok && resultado.message.kind === 'alert') {
      expect(resultado.message.severity).toBe('CRITICAL');
    }
  });

  it('normaliza una severidad nueva a INFO en vez de perder la alerta', () => {
    const crudo = JSON.stringify({
      v: 1,
      kind: 'alert',
      stack: 'spring',
      ts: 'x',
      severity: 'CATASTROPHIC',
      type: 'X',
      subject: 'S',
      detail: 'd',
      value: '1',
      raisedAt: 'y',
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeTrue();
    if (resultado.ok && resultado.message.kind === 'alert') {
      expect(resultado.message.severity).toBe('INFO');
    }
  });

  it('ignora campos nuevos sin romperse: el backend puede anadir sin avisar', () => {
    const crudo = JSON.stringify({
      v: 2,
      kind: 'snapshot',
      stack: 'spring',
      ts: '2026-09-17T08:00:00.123Z',
      ticksIn: 1,
      ticksOut: 1,
      symbols: {},
      campoQueNoExisteTodavia: { anidado: [1, 2, 3] },
    });
    const resultado = parseLiveMessage(crudo);
    expect(resultado.ok).toBeTrue();
    if (resultado.ok) {
      expect(resultado.message.v).toBe(2);
    }
  });

  it('no lanza nunca, pase lo que pase', () => {
    const basura = ['', 'null', '0', '"texto"', '[]', '{}', '{"kind":null}', '<xml/>', 'NaN'];
    for (const crudo of basura) {
      expect(() => parseLiveMessage(crudo)).not.toThrow();
      expect(parseLiveMessage(crudo).ok).toBeFalse();
    }
  });
});
