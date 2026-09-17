import { TestBed } from '@angular/core/testing';
import { LiveService } from './live.service';
import { environment } from '../../environments/environment';

/**
 * La ventana movil del WebSocket.
 *
 * Llega un snapshot por segundo y la pagina solo necesita la forma reciente. Estos tests fijan dos
 * cosas: que la ventana **se corta** (no crece sin fin, que es como se tumba una pestana abierta tres
 * dias) y que un frame invalido no entra en ella.
 *
 * El WebSocket se sustituye por un doble: la red no se toca y no hay backend en los tests.
 */
class WebSocketFalso {
  static readonly instancias: WebSocketFalso[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evento: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  cerrado = false;

  constructor(url: string) {
    this.url = url;
    WebSocketFalso.instancias.push(this);
  }

  emitir(mensaje: unknown): void {
    this.onmessage?.({ data: typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje) });
  }

  abrir(): void {
    this.onopen?.();
  }

  close(): void {
    this.cerrado = true;
    this.onclose?.();
  }
}

function snapshot(ticksIn: number, ticksOut: number, ts: string) {
  return {
    v: 1,
    kind: 'snapshot',
    stack: 'spring',
    ts,
    ticksIn,
    ticksOut,
    symbols: { 'EUR/USD': { price: '1.1', currency: 'USD', size: 1, source: 'X', at: ts } },
  };
}

describe('LiveService', () => {
  const WebSocketOriginal = globalThis.WebSocket;

  beforeEach(() => {
    WebSocketFalso.instancias.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = WebSocketFalso;
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = WebSocketOriginal;
  });

  function crear(): { servicio: LiveService; sockets: WebSocketFalso[] } {
    const servicio = TestBed.inject(LiveService);
    servicio.start();
    return { servicio, sockets: WebSocketFalso.instancias };
  }

  it('abre un socket por stack, con la URL del contrato', () => {
    const { sockets } = crear();
    expect(sockets.length).toBe(2);
    const urls = sockets.map((socket) => socket.url).sort();
    expect(urls[0]).toContain('/ws');
    expect(urls[1]).toContain('/ws');
    expect(urls.some((url) => url.includes('8089'))).toBeTrue();
    expect(sockets.some((url) => url.url.includes('8189'))).toBeTrue();
  });

  it('guarda la ventana movil de los snapshots', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    spring.emitir(snapshot(10, 2, '2026-09-17T08:00:00Z'));
    spring.emitir(snapshot(20, 3, '2026-09-17T08:00:01Z'));

    const estado = servicio.live().spring;
    expect(estado.state).toBe('open');
    expect(estado.history.length).toBe(2);
    expect(estado.history[0].ticksIn).toBe(10);
    expect(estado.history[1].ticksIn).toBe(20);
    // La ultima foto completa: es la que se ensena por simbolo.
    expect(estado.lastSnapshot?.ticksOut).toBe(3);
    expect(Object.keys(estado.lastSnapshot!.symbols)).toEqual(['EUR/USD']);
  });

  it('corta la ventana en tickWindow: no crece sin fin', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    for (let i = 0; i < environment.tickWindow + 25; i += 1) {
      spring.emitir(snapshot(i, 1, `2026-09-17T08:00:${String(i % 60).padStart(2, '0')}Z`));
    }
    const historial = servicio.live().spring.history;
    expect(historial.length).toBe(environment.tickWindow);
    // Se queda con lo ultimo, no con lo primero.
    expect(historial.at(-1)!.ticksIn).toBe(environment.tickWindow + 24);
  });

  it('un frame invalido no entra en la ventana y deja un error explicado', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    spring.emitir(snapshot(10, 2, '2026-09-17T08:00:00Z'));
    spring.emitir('<html>502</html>');
    spring.emitir(JSON.stringify({ v: 1, kind: 'snapshot', stack: 'spring', ts: 'x', symbols: {} }));

    const estado = servicio.live().spring;
    expect(estado.history.length).toBe(1);
    expect(estado.lastParseError).not.toBeNull();
    expect(estado.lastParseError!.reason).toContain('ticksIn');
    // El contador de snapshots solo cuenta los buenos.
    expect(estado.counters['snapshot']).toBe(1);
  });

  it('acumula alertas y posiciones al momento, sin esperar al segundo', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    spring.emitir({
      v: 1,
      kind: 'alert',
      stack: 'spring',
      ts: 'x',
      severity: 'CRITICAL',
      type: 'VOLATILITY_SPIKE',
      subject: 'ASML',
      detail: 'd',
      value: '1',
      raisedAt: 'x',
    });
    spring.emitir({
      v: 1,
      kind: 'position',
      stack: 'spring',
      ts: 'x',
      account: 'ACC-1',
      symbol: 'AAPL',
      quantity: 100,
      averageCost: '333.47',
      realizedPnl: '0',
      exposure: '33347',
      currency: 'USD',
      marginBreach: false,
    });
    const estado = servicio.live().spring;
    expect(estado.alerts.length).toBe(1);
    expect(estado.alerts[0].severity).toBe('CRITICAL');
    expect(estado.positions.length).toBe(1);
    expect(estado.counters['alert']).toBe(1);
    expect(estado.counters['position']).toBe(1);
  });

  it('reemplaza la posicion de la misma cuenta y simbolo en vez de duplicarla', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    const base = {
      v: 1,
      kind: 'position',
      stack: 'spring',
      ts: 'x',
      account: 'ACC-1',
      symbol: 'AAPL',
      averageCost: '333.47',
      realizedPnl: '0',
      exposure: '33347',
      currency: 'USD',
      marginBreach: false,
    };
    spring.emitir({ ...base, quantity: 100 });
    spring.emitir({ ...base, quantity: 150 });
    const posiciones = servicio.live().spring.positions;
    expect(posiciones.length).toBe(1);
    expect(posiciones[0].quantity).toBe(150);
  });

  it('stop cierra los sockets y cancela la reconexion', () => {
    const { servicio, sockets } = crear();
    servicio.stop();
    expect(WebSocketFalso.instancias.length).toBe(2);
    expect(sockets.every((socket) => socket.cerrado)).toBeTrue();
    expect(servicio.connected()).toBeFalse();
  });

  it('al cerrarse un socket pasa a reconnecting y suma el intento', () => {
    const { servicio, sockets } = crear();
    const spring = sockets.find((socket) => socket.url.includes('8089'))!;
    spring.abrir();
    spring.close();
    const estado = servicio.live().spring;
    expect(estado.state).toBe('reconnecting');
    expect(estado.reconnects).toBe(1);
    servicio.stop();
  });
});
