import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { appConfig } from './app.config';
import { LiveService } from './core/live.service';
import { MetricsService } from './core/metrics.service';

/**
 * El shell de la pagina.
 *
 * El componente abre un WebSocket de verdad y pide paneles de verdad. En un test eso no se puede
 * dejar suelto: aqui se sustituyen el WebSocket y `fetch` por dobles (no se toca la red). Sin eso,
 * Karma avisa de que quedan tareas vivas y los tests se cuelgan, que es justo lo que se quiere
 * evitar.
 *
 * Ojo con los providers: **se usa el `appConfig` de verdad**, no una lista hecha a mano. Un test que
 * se inventa sus providers deja de comprobar lo que se compila.
 */
class WebSocketFalso {
  onopen: (() => void) | null = null;
  onmessage: ((evento: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {}
}

describe('App', () => {
  const WebSocketOriginal = globalThis.WebSocket;
  const fetchOriginal = globalThis.fetch;
  /** Peticiones de paneles pendientes, para responderlas desde el test. */
  let pendientes: (() => void)[] = [];

  beforeEach(async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = WebSocketFalso;
    pendientes = [];
    // Doble de `fetch`: la app pide los paneles por ahi.
    (globalThis as { fetch: unknown }).fetch = (url: string | URL) =>
      new Promise((resolver) => {
        pendientes.push(() =>
          resolver({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  panel: 'pulso',
                  ts: new Date().toISOString(),
                  stack: 'spring',
                  series: [{ label: 'entrada', points: [[1, 36.1]] }],
                }),
              ),
          } as unknown as Response),
        );
        void url;
      });
    await TestBed.configureTestingModule({
      imports: [App],
      // El config real de la app: si le falta algo, el test se pone rojo.
      providers: [...appConfig.providers],
    }).compileComponents();
  });

  afterEach(() => {
    // El root arranca el reloj, los sockets y el sondeo: se paran para que Karma pueda terminar.
    const fixture = TestBed.createComponent(App);
    fixture.componentRef.destroy();
    (globalThis as { WebSocket: unknown }).WebSocket = WebSocketOriginal;
    (globalThis as { fetch: unknown }).fetch = fetchOriginal;
  });

  /** Responde a todo lo pendiente con un panel valido. */
  function responderPendientes(): void {
    for (const responder of pendientes.splice(0)) {
      responder();
    }
  }

  it('se crea y pinta la cabecera', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).toContain('Aggora');
    expect(html).toContain('Spring');
    expect(html).toContain('Quarkus');
    fixture.componentRef.destroy();
    responderPendientes();
  });

  it('el selector tiene las tres posiciones, con el modo lado a lado', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).toContain('Spring + Quarkus');
    fixture.componentRef.destroy();
    responderPendientes();
  });

  it('ensena la frase de cada panel aunque el dato aun no haya llegado', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // Los siete paneles del contrato estan en pantalla, con su explicacion.
    expect(texto).toContain('Pulse');
    expect(texto).toContain('Consumer lag');
    expect(texto).toContain('Partitions');
    expect(texto).toContain('Dead letters');
    expect(texto).toContain('Health');
    expect(texto).toContain('Transactions');
    expect(texto).toContain('Side by side');
    // Y el modo leccion, con las cinco lecciones.
    expect(texto).toContain('Lesson mode');
    expect(texto).toContain('leccion-1-broker-caido.sh');
    expect(texto).toContain('leccion-5-streams-muerto.sh');
    fixture.componentRef.destroy();
    responderPendientes();
  });

  it('el panel de transacciones explica el hueco en vez de inventar un numero', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    responderPendientes();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('This panel is empty on purpose');
    fixture.componentRef.destroy();
  });

  it('arranca el WebSocket y el sondeo de paneles', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(TestBed.inject(LiveService).live().spring.state).toBe('connecting');
    // Los paneles se piden en cuanto arranca la app, sin esperar al primer intervalo.
    expect(pendientes.length).toBeGreaterThan(0);
    fixture.componentRef.destroy();
    TestBed.inject(MetricsService).stop();
    responderPendientes();
  });
});
