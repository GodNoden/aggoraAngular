import { TestBed } from '@angular/core/testing';
import { Catalog } from './catalog';

/**
 * El catalogo se prueba con un `fetch` de mentira: lo que importa aqui es que se distinga un panel
 * vacio **con nota** (informacion) de un error de red (averia), y que la ventana de las graficas se
 * llene sin repetir valores.
 */
describe('Catalog', () => {
  let catalog: Catalog;
  const original = globalThis.fetch;
  let pedidas: string[] = [];
  let responder: (url: string) => { status?: number; body: unknown } = () => ({ body: { panel: 'x', ts: 't', stack: 'spring', series: [] } });

  beforeEach(() => {
    pedidas = [];
    (globalThis as { fetch: unknown }).fetch = (url: string | URL) => {
      const texto = String(url);
      pedidas.push(texto);
      const { status = 200, body } = responder(texto);
      const panel = /panel=([a-z]+)/.exec(texto)?.[1] ?? 'x';
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(typeof body === 'function' ? body(panel) : body)),
      } as unknown as Response);
    };
    TestBed.configureTestingModule({});
    catalog = TestBed.inject(Catalog);
  });

  afterEach(() => {
    catalog.stop();
    (globalThis as { fetch: unknown }).fetch = original;
  });

  it('pide los seis paneles y la comparativa a los dos stacks', async () => {
    await catalog.refresh();
    // 6 paneles x 2 stacks + comparativa x 2 stacks
    expect(pedidas.length).toBe(14);
    for (const panel of ['pulso', 'lag', 'particiones', 'descartes', 'salud', 'transacciones']) {
      expect(pedidas.some((url) => url.includes(`panel=${panel}`) && url.includes('/api/'))).toBeTrue();
      expect(pedidas.some((url) => url.includes(`panel=${panel}`) && url.includes('/q/api/'))).toBeTrue();
    }
    // El catalogo es cerrado: nunca se manda PromQL.
    expect(pedidas.some((url) => url.includes('query='))).toBeFalse();
  });

  it('un panel vacio con nota es informacion, no un error', async () => {
    responder = (url) => ({
      body: {
        panel: /panel=([a-z]+)/.exec(url)?.[1] ?? 'x',
        ts: 't',
        stack: 'spring',
        series: [],
        nota: 'esa metrica no existe en este Prometheus',
      },
    });
    await catalog.refresh();
    const estado = catalog.entry('transacciones', 'spring');
    expect(estado.status).toBe('vacio');
    expect(estado.note).toContain('no existe');
  });

  it('un 502 es un error y dice donde llamo', async () => {
    responder = () => ({ status: 502, body: { error: 'prometheus no responde' } });
    await catalog.refresh();
    const estado = catalog.entry('salud', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('502');
    expect(estado.note).toContain('panel=salud');
    expect(catalog.hayErrores()).toBeTrue();
  });

  it('una respuesta con otra forma se marca como error, no como panel vacio', async () => {
    responder = () => ({ body: { algo: 'que no es el contrato' } });
    await catalog.refresh();
    expect(catalog.entry('pulso', 'spring').status).toBe('error');
    expect(catalog.entry('pulso', 'spring').note).toContain('forma del contrato');
  });

  it('guarda la ventana de cada serie y no repite un valor que no ha cambiado', async () => {
    let valor = 10;
    responder = (url) => ({
      body: {
        panel: /panel=([a-z]+)/.exec(url)?.[1] ?? 'x',
        ts: 't',
        stack: 'spring',
        series: [{ label: 'entrada', points: [[1, valor]] }],
      },
    });
    await catalog.refresh();
    expect(catalog.serie('pulso', 'spring', 'entrada')).toEqual([10]);

    // El mismo valor otra vez: no se apunta repetido.
    await catalog.refresh();
    expect(catalog.serie('pulso', 'spring', 'entrada')).toEqual([10]);

    valor = 20;
    await catalog.refresh();
    expect(catalog.serie('pulso', 'spring', 'entrada')).toEqual([10, 20]);
  });

  it('arranca el sondeo y para cuando se le dice', async () => {
    await catalog.refresh();
    expect(catalog.ciclos()).toBe(1);
    catalog.start();
    catalog.start(); // idempotente
    catalog.stop();
    catalog.stop();
  });
});
