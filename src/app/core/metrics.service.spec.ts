import { TestBed } from '@angular/core/testing';
import { MetricsService } from './metrics.service';
import { REQUEST_TIMEOUT_MS, describirErrorHttp, getJson } from './http';
import { environment } from '../../environments/environment';

/**
 * Doble de `fetch`.
 *
 * La app habla con el backend con `fetch` (ver `core/http.ts`), asi que los tests interceptan ahi y
 * no en `HttpClient`.
 *
 * El refresco del catalogo es **en serie** (una peticion detras de otra), asi que la forma comoda de
 * responder es una **politica**: en cuanto sale una peticion, el doble contesta lo que diga el test.
 */
interface PeticionFalsa {
  readonly url: string;
  responder: (cuerpo: unknown, status?: number) => void;
  fallar: (error: unknown) => void;
}

let peticiones: PeticionFalsa[] = [];
/** Si hay politica, cada peticion se contesta en cuanto sale. */
let politica: { decidir: (url: string) => unknown; status: number } | null = null;

function programarRespuesta(decidir: (url: string) => unknown, status = 200): void {
  politica = { decidir, status };
}

function instalarFetch(): void {
  (globalThis as { fetch: unknown }).fetch = (url: string | URL, opciones?: { signal?: AbortSignal }) =>
    new Promise((resolver, rechazar) => {
      // El doble respeta el AbortSignal: es la pieza con la que se prueba el timeout.
      opciones?.signal?.addEventListener('abort', () => {
        rechazar(new DOMException('abortado', 'AbortError'));
      });
      const peticion: PeticionFalsa = {
        url: String(url),
        responder: (cuerpo, status = 200) => {
          const texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
          resolver({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(texto),
          } as unknown as Response);
        },
        fallar: (error) => rechazar(error),
      };
      peticiones.push(peticion);
      if (politica) {
        peticion.responder(politica.decidir(peticion.url), politica.status);
        peticiones = peticiones.filter((otra) => otra !== peticion);
      }
    });
}

describe('MetricsService', () => {
  let servicio: MetricsService;
  const fetchOriginal = globalThis.fetch;

  beforeEach(() => {
    peticiones = [];
    politica = null;
    instalarFetch();
    TestBed.configureTestingModule({});
    servicio = TestBed.inject(MetricsService);
  });

  afterEach(() => {
    servicio.stop();
    (globalThis as { fetch: unknown }).fetch = fetchOriginal;
  });

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

  /** Refresco completo con una politica de respuesta. */
  async function refrescar(
    decidir: (url: string) => unknown = (url) => respuesta(panelDeLaUrl(url), [], 'sin datos'),
    status = 200,
  ): Promise<void> {
    programarRespuesta(decidir, status);
    await servicio.refreshAll();
  }

  it('pide los seis paneles simples a los dos stacks, y la comparativa', async () => {
    const vistas: string[] = [];
    await refrescar((url) => {
      vistas.push(url);
      return respuesta(panelDeLaUrl(url), [], 'sin datos');
    });
    // 6 paneles x 2 stacks + 1 comparativa x 2 stacks
    expect(vistas.length).toBe(14);
    for (const panel of ['pulso', 'lag', 'particiones', 'transacciones', 'descartes', 'salud']) {
      expect(
        vistas.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.spring.gateway)),
      ).toBeTrue();
      expect(
        vistas.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.quarkus.gateway)),
      ).toBeTrue();
    }
    expect(vistas.some((url) => url.includes('panel=comparativa') && url.includes('de=pulso'))).toBeTrue();
    // Nunca se manda PromQL libre: el catalogo es cerrado y el panel es la unica entrada.
    expect(vistas.some((url) => url.includes('query='))).toBeFalse();
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

  it('un error HTTP se cuenta como error con la URL y no tumba el resto', async () => {
    await refrescar(
      (url) =>
        url.includes('panel=salud')
          ? { error: 'prometheus no responde', detalle: 'timeout' }
          : respuesta('x', [{ label: 'a', points: [[1, 1]] }]),
      502,
    );
    // Todas las peticiones de este ciclo fallan con 502 (la politica es unica), asi que se comprueba
    // que el error se explica y que la app no se rompe.
    const salud = servicio.panel('salud', 'spring');
    expect(salud.status).toBe('error');
    expect(salud.note).toContain('502');
    expect(salud.note).toContain('prometheus no responde');
    expect(servicio.hasErrors()).toBeTrue();

    // Y con el backend recuperado, los paneles vuelven solos en el siguiente ciclo.
    await refrescar((url) => respuesta(panelDeLaUrl(url), [{ label: 'a', points: [[1, 1]] }]));
    expect(servicio.panel('pulso', 'spring').status).toBe('ok');
    expect(servicio.panel('salud', 'spring').status).toBe('ok');
  });

  it('el 400 del catalogo cerrado se ensena con el mensaje y el catalogo del backend', async () => {
    await refrescar(
      () => ({ error: 'panel desconocido: descartes', detalle: ['pulso', 'lag', 'salud'] }),
      400,
    );
    const estado = servicio.panel('descartes', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('panel desconocido: descartes');
    expect(estado.note).toContain('pulso, lag, salud');
  });

  it('un fallo de red lo dice con la URL del stack', async () => {
    // La peticion de Quarkus falla; las de Spring responden.
    (globalThis as { fetch: unknown }).fetch = (url: string | URL) =>
      new Promise((resolver, rechazar) => {
        if (String(url).includes(environment.quarkus.gateway)) {
          rechazar(new Error('connection refused'));
          return;
        }
        resolver({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(respuesta('x', [], 'n'))),
        } as unknown as Response);
      });
    await servicio.refreshAll();
    const estado = servicio.panel('pulso', 'quarkus');
    expect(estado.status).toBe('error');
    // El aviso dice a donde llamo, con el endpoint completo.
    expect(estado.note).toContain(environment.quarkus.gateway);
    expect(estado.note).toContain('panel=pulso');
  });

  it('una peticion que no responde nunca pasa a error con el endpoint y su tiempo', async () => {
    // Se prueba la capa de peticion directamente: es donde vive el timeout, y asi el test no depende
    // de la serie de paneles.
    jasmine.clock().install();
    try {
      const enVuelo = getJson('/api/metrics?panel=pulso');
      expect(peticiones.length).toBe(1);

      // Nadie contesta: el reloj avanza mas alla del timeout y se aborta.
      jasmine.clock().tick(REQUEST_TIMEOUT_MS + 100);
      let error: unknown = null;
      try {
        await enVuelo;
      } catch (fallo) {
        error = fallo;
      }

      expect(error).not.toBeNull();
      const mensaje = describirErrorHttp(error, 'panel "pulso"');
      expect(mensaje).toContain('no hubo respuesta');
      expect(mensaje).toContain('/api/metrics?panel=pulso');
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('requestedAt se apunta al lanzar: la UI puede saber cuanto lleva esperando', async () => {
    await refrescar();
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.requestedAt).not.toBeNull();
    expect(estado.requestedAt! <= Date.now()).toBeTrue();
  });

  it('una respuesta con forma invalida se marca como error, no como panel vacio', async () => {
    await refrescar(() => ({ algo: 'que no es el contrato' }));
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('forma del contrato');
  });

  it('cambiar el panel de comparativa lo vuelve a pedir con su de', async () => {
    programarRespuesta(() => ({ panel: 'comparativa', de: 'descartes', ts: 'x', stack: 'spring', series: [] }));
    servicio.setComparisonPanel('descartes');
    expect(servicio.comparisonPanel()).toBe('descartes');
    // `setComparisonPanel` no devuelve promesa: se le da turno a la microcola hasta que el panel
    // tenga datos (con la politica puesta, la peticion se contesta sola).
    for (let intento = 0; intento < 20 && !servicio.panel('comparativa', 'spring').data; intento += 1) {
      await Promise.resolve();
    }
    expect(servicio.panel('comparativa', 'spring').data?.de).toBe('descartes');
  });

  it('el intervalo configurado esta entre 5 y 10 segundos: educacion con Prometheus', () => {
    expect(environment.metricsIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(environment.metricsIntervalMs).toBeLessThanOrEqual(10000);
  });

  it('start arranca el refresco: los paneles acaban en ok sin esperar al primer intervalo', async () => {
    programarRespuesta((url) => respuesta(panelDeLaUrl(url), [{ label: 'entrada', points: [[1, 1]] }]));
    servicio.start();
    for (let intento = 0; intento < 50 && servicio.panel('pulso', 'spring').status !== 'ok'; intento += 1) {
      await Promise.resolve();
    }
    expect(servicio.panel('pulso', 'spring').status).toBe('ok');
  });

  it('un ciclo colgado no bloquea los siguientes: se descarta y se empieza otro', () => {
    // Primer ciclo: nadie responde, asi que se queda en vuelo.
    void servicio.refreshAll();
    expect(peticiones.length).toBeGreaterThan(0);

    // Han pasado mas de REQUEST_TIMEOUT_MS + 5 s (se falsea el arranque del ciclo en vez de esperar
    // 15 segundos reales): el siguiente ciclo tiene que poder arrancar igualmente.
    (servicio as unknown as { inicioCiclo: number }).inicioCiclo = Date.now() - (REQUEST_TIMEOUT_MS + 6000);
    const antes = peticiones.length;
    void servicio.refreshAll();
    expect(peticiones.length).toBeGreaterThan(antes);
    expect(servicio.descartados).toBe(1);
  });

  it('un panel que aun no se ha pedido devuelve un estado inicial y no revienta', () => {
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('loading');
    expect(estado.data).toBeNull();
    expect(estado.note).toBeNull();
  });
});
