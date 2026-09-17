import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MetricsService } from './metrics.service';
import { environment } from '../../environments/environment';

/**
 * El servicio del catalogo de metricas.
 *
 * Lo que se fija aqui son las dos reglas de educacion del encargo:
 *
 *  - Los paneles se piden cada 5-10 s, no cada segundo. El WebSocket es el que va por segundo.
 *  - Un panel con `series: []` se marca como "no hay dato" y **se conserva la nota del backend**; no
 *    se rellena con nada.
 *
 * Nota sobre el orden: `flush` es sincrono y la escritura del estado ocurre unas microtareas
 * despues, asi que las pruebas disparan el refresco, responden y **esperan** antes de mirar el
 * estado. Mirar antes de tiempo solo mide la impaciencia del test.
 */
describe('MetricsService', () => {
  let servicio: MetricsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    servicio = TestBed.inject(MetricsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    servicio.stop();
    http.verify();
  });

  /** Respuesta valida minima para un panel. */
  function respuesta(panel: string, series: unknown[] = [], nota?: string): Record<string, unknown> {
    return {
      panel,
      ts: new Date().toISOString(),
      stack: 'spring',
      series,
      ...(nota ? { nota } : {}),
    };
  }

  function panelDeLaUrl(url: string): string {
    const coincidencia = /panel=([a-z]+)/.exec(url);
    return coincidencia ? coincidencia[1] : 'x';
  }

  /**
   * Dispara un refresco de los 14 endpoints, responde a cada uno con lo que decida `decidir` y
   * espera a que el servicio termine de escribir el estado.
   */
  async function refrescar(
    decidir: (url: string) => Record<string, unknown> = (url) => respuesta(panelDeLaUrl(url), [], 'sin datos'),
  ): Promise<void> {
    const enVuelo = servicio.refreshAll();
    // Las peticiones existen cuando el HttpClient se suscribe, en el primer turno de la microcola.
    await Promise.resolve();
    for (const peticion of http.match(() => true)) {
      peticion.flush(decidir(peticion.request.urlWithParams));
    }
    await enVuelo;
  }

  it('pide los seis paneles simples a los dos stacks, y la comparativa', async () => {
    const enVuelo = servicio.refreshAll();
    await Promise.resolve();
    const peticiones = http.match(() => true);
    const urls = peticiones.map((peticion) => peticion.request.urlWithParams);
    // 6 paneles x 2 stacks + 1 comparativa x 2 stacks
    expect(peticiones.length).toBe(14);
    for (const panel of ['pulso', 'lag', 'particiones', 'transacciones', 'descartes', 'salud']) {
      expect(
        urls.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.spring.gateway)),
      ).toBeTrue();
      expect(
        urls.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.quarkus.gateway)),
      ).toBeTrue();
    }
    expect(
      urls.some((url) => url.includes('panel=comparativa') && url.includes('de=pulso')),
    ).toBeTrue();
    // Nunca se manda PromQL libre: el catalogo es cerrado y el panel es la unica entrada.
    expect(urls.some((url) => url.includes('query='))).toBeFalse();
    for (const peticion of peticiones) {
      peticion.flush(respuesta('x', [], 'sin datos'));
    }
    await enVuelo;
  });

  it('marca un panel vacio como empty y conserva la nota del backend', async () => {
    const nota = 'Prometheus no publica confirmadas frente a abortadas';
    await refrescar((url) =>
      panelDeLaUrl(url) === 'transacciones'
        ? respuesta('transacciones', [], nota)
        : respuesta(panelDeLaUrl(url), [{ label: 'a', points: [[1, 1]] }]),
    );
    const estado = servicio.panel('transacciones', 'spring');
    expect(estado.status).toBe('empty');
    expect(estado.note).toBe(nota);
    expect(estado.data?.series.length).toBe(0);
    // Un panel vacio con nota NO es un error: es "no hay dato", que es lo que promete el contrato.
    expect(estado.warnings).toEqual([]);
  });

  it('marca ok un panel con series', async () => {
    await refrescar((url) =>
      panelDeLaUrl(url) === 'lag'
        ? respuesta('lag', [{ label: 'ingestion-normalizer', points: [[1, 0]] }])
        : respuesta(panelDeLaUrl(url), [], 'sin datos'),
    );
    const estado = servicio.panel('lag', 'spring');
    expect(estado.status).toBe('ok');
    expect(estado.note).toBeNull();
    expect(estado.data?.series.length).toBe(1);
    expect(estado.fetchedAt).not.toBeNull();
    expect(estado.elapsedMs).not.toBeNull();
  });

  it('guarda el aviso de contrato cuando el panel no cumple su promesa', async () => {
    await refrescar((url) =>
      panelDeLaUrl(url) === 'pulso'
        ? respuesta('pulso', [{ label: 'entrada', points: [[1, 1]] }], 'nota que no deberia estar')
        : respuesta(panelDeLaUrl(url), [], 'sin datos'),
    );
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('ok');
    expect(estado.warnings.some((aviso) => aviso.includes('series Y nota'))).toBeTrue();
  });

  it('un error de red se cuenta como error con la URL y no tumba el resto', async () => {
    const enVuelo = servicio.refreshAll();
    await Promise.resolve();
    for (const peticion of http.match(() => true)) {
      if (!peticion.request.urlWithParams.includes(environment.spring.gateway)) {
        // El otro stack responde bien: asi se comprueba que un panel caido no arrastra al resto.
        peticion.flush(respuesta('x', [{ label: 'a', points: [[1, 1]] }]));
      } else if (peticion.request.urlWithParams.includes('panel=salud')) {
        peticion.flush(
          { error: 'prometheus no responde', detalle: 'timeout' },
          { status: 502, statusText: 'Bad Gateway' },
        );
      } else {
        peticion.flush(respuesta('x', [{ label: 'a', points: [[1, 1]] }]));
      }
    }
    await enVuelo;
    const salud = servicio.panel('salud', 'spring');
    expect(salud.status).toBe('error');
    expect(salud.note).toContain('502');
    expect(salud.note).toContain('prometheus no responde');
    // Los demas paneles siguen bien: un panel caido no arrastra a los otros.
    expect(servicio.panel('pulso', 'spring').status).toBe('ok');
    expect(servicio.hasErrors()).toBeTrue();
  });

  it('el 400 del catalogo cerrado se ensena con el mensaje del backend', async () => {
    const enVuelo = servicio.refreshAll();
    await Promise.resolve();
    for (const peticion of http.match(() => true)) {
      if (peticion.request.urlWithParams.includes('panel=descartes')) {
        peticion.flush(
          { error: 'panel desconocido: descartes', detalle: ['pulso', 'lag', 'salud'] },
          { status: 400, statusText: 'Bad Request' },
        );
      } else {
        peticion.flush(respuesta('x', [], 'n'));
      }
    }
    await enVuelo;
    const estado = servicio.panel('descartes', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('panel desconocido: descartes');
    expect(estado.note).toContain('pulso, lag, salud');
  });

  it('un gateway apagado (status 0) lo dice con la ruta del stack', async () => {
    const enVuelo = servicio.refreshAll();
    await Promise.resolve();
    for (const peticion of http.match(() => true)) {
      if (peticion.request.urlWithParams.includes(environment.quarkus.gateway)) {
        peticion.error(new ProgressEvent('error'));
      } else {
        peticion.flush(respuesta('x', [], 'n'));
      }
    }
    await enVuelo;
    const estado = servicio.panel('pulso', 'quarkus');
    expect(estado.status).toBe('error');
    // El aviso dice a donde llamo: es la ruta del gateway de Quarkus, no un puerto suelto.
    expect(estado.note).toContain(environment.quarkus.gateway);
    expect(estado.note).toContain('CORS');
  });

  it('una respuesta con forma invalida se marca como error, no como panel vacio', async () => {
    await refrescar(() => ({ algo: 'que no es el contrato' }));
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('forma del contrato');
  });

  it('cambiar el panel de comparativa lo vuelve a pedir con su de', async () => {
    servicio.setComparisonPanel('descartes');
    expect(servicio.comparisonPanel()).toBe('descartes');
    await Promise.resolve();
    const peticiones = http.match(() => true);
    expect(peticiones.length).toBe(2);
    for (const peticion of peticiones) {
      expect(peticion.request.urlWithParams).toContain('panel=comparativa');
      expect(peticion.request.urlWithParams).toContain('de=descartes');
      peticion.flush({
        panel: 'comparativa',
        de: 'descartes',
        ts: 'x',
        stack: 'spring',
        series: [],
      });
    }
    await Promise.resolve();
  });

  it('el intervalo configurado esta entre 5 y 10 segundos: educacion con Prometheus', () => {
    expect(environment.metricsIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(environment.metricsIntervalMs).toBeLessThanOrEqual(10000);
  });

  it('start arranca el refresco una sola vez aunque se llame dos veces', async () => {
    servicio.start();
    servicio.start();
    await Promise.resolve();
    const peticiones = http.match(() => true);
    expect(peticiones.length).toBe(14);
    for (const peticion of peticiones) {
      peticion.flush(respuesta('x', [], 'n'));
    }
    await Promise.resolve();
  });

  it('un panel que aun no se ha pedido devuelve un estado inicial y no revienta', () => {
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('loading');
    expect(estado.data).toBeNull();
    expect(estado.note).toBeNull();
  });
});
