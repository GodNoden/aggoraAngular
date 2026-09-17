import { TestBed } from '@angular/core/testing';
import { MetricsService } from './metrics.service';
import { REQUEST_TIMEOUT_MS } from './http';
import { environment } from '../../environments/environment';

/**
 * Doble de `fetch`.
 *
 * La app habla con el backend con `fetch` (ver `core/http.ts`), asi que los tests interceptan ahi y
 * no en `HttpClient`. Cada peticion queda apuntada y el test decide cuando y como se responde: eso
 * permite probar el caso que mas importa, que una peticion no conteste nunca.
 */
interface PeticionFalsa {
  readonly url: string;
  responder: (cuerpo: unknown, status?: number) => void;
  fallar: (error: unknown) => void;
}

const peticiones: PeticionFalsa[] = [];

function instalarFetch(): void {
  (globalThis as { fetch: unknown }).fetch = (url: string | URL, opciones?: { signal?: AbortSignal }) =>
    new Promise((resolver, rechazar) => {
      // El doble respeta el AbortSignal: es la pieza con la que se prueba el timeout.
      opciones?.signal?.addEventListener('abort', () => {
        rechazar(new DOMException('abortado', 'AbortError'));
      });
      peticiones.push({
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
      });
    });
}

function responderTodas(decidir: (url: string) => unknown, status = 200): void {
  for (const peticion of peticiones.splice(0)) {
    peticion.responder(decidir(peticion.url), status);
  }
}

/**
 * El servicio del catalogo de metricas.
 *
 * Lo que se fija aqui son las reglas de la casa:
 *
 *  - Los paneles se piden cada 5-10 s, no cada segundo. El WebSocket es el que va por segundo.
 *  - Un panel con `series: []` se marca como "no hay dato" y conserva la nota del backend.
 *  - **Ninguna peticion se queda colgada**: hay timeout, y el error dice que endpoint fallo.
 */
describe('MetricsService', () => {
  let servicio: MetricsService;
  const fetchOriginal = globalThis.fetch;

  beforeEach(() => {
    peticiones.length = 0;
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

  /** Dispara un refresco, responde a todo y espera a que el estado se asiente. */
  async function refrescar(
    decidir: (url: string) => unknown = (url) => respuesta(panelDeLaUrl(url), [], 'sin datos'),
  ): Promise<void> {
    const enVuelo = servicio.refreshAll();
    await Promise.resolve();
    responderTodas(decidir);
    await enVuelo;
  }

  it('pide los seis paneles simples a los dos stacks, y la comparativa', async () => {
    const enVuelo = servicio.refreshAll();
    const urls = peticiones.map((peticion) => peticion.url);
    // 6 paneles x 2 stacks + 1 comparativa x 2 stacks
    expect(urls.length).toBe(14);
    for (const panel of ['pulso', 'lag', 'particiones', 'transacciones', 'descartes', 'salud']) {
      expect(
        urls.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.spring.gateway)),
      ).toBeTrue();
      expect(
        urls.some((url) => url.includes(`panel=${panel}`) && url.includes(environment.quarkus.gateway)),
      ).toBeTrue();
    }
    expect(urls.some((url) => url.includes('panel=comparativa') && url.includes('de=pulso'))).toBeTrue();
    // Nunca se manda PromQL libre: el catalogo es cerrado y el panel es la unica entrada.
    expect(urls.some((url) => url.includes('query='))).toBeFalse();
    responderTodas(() => respuesta('x', [], 'sin datos'));
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

  it('un error HTTP se cuenta como error con la URL y no tumba el resto', async () => {
    const enVuelo = servicio.refreshAll();
    for (const peticion of peticiones.splice(0)) {
      if (peticion.url.includes('panel=salud')) {
        peticion.responder({ error: 'prometheus no responde', detalle: 'timeout' }, 502);
      } else {
        peticion.responder(respuesta('x', [{ label: 'a', points: [[1, 1]] }]));
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

  it('el 400 del catalogo cerrado se ensena con el mensaje y el catalogo del backend', async () => {
    const enVuelo = servicio.refreshAll();
    for (const peticion of peticiones.splice(0)) {
      if (peticion.url.includes('panel=descartes')) {
        peticion.responder({ error: 'panel desconocido: descartes', detalle: ['pulso', 'lag', 'salud'] }, 400);
      } else {
        peticion.responder(respuesta('x', [], 'n'));
      }
    }
    await enVuelo;
    const estado = servicio.panel('descartes', 'spring');
    expect(estado.status).toBe('error');
    expect(estado.note).toContain('panel desconocido: descartes');
    expect(estado.note).toContain('pulso, lag, salud');
  });

  it('un fallo de red lo dice con la URL del stack', async () => {
    const enVuelo = servicio.refreshAll();
    for (const peticion of peticiones.splice(0)) {
      if (peticion.url.includes(environment.quarkus.gateway)) {
        peticion.fallar(new Error('connection refused'));
      } else {
        peticion.responder(respuesta('x', [], 'n'));
      }
    }
    await enVuelo;
    const estado = servicio.panel('pulso', 'quarkus');
    expect(estado.status).toBe('error');
    // El aviso dice a donde llamo, con el endpoint completo.
    expect(estado.note).toContain(environment.quarkus.gateway);
    expect(estado.note).toContain('panel=pulso');
  });

  it('una peticion que no responde nunca pasa a error con el endpoint y su tiempo', async () => {
    jasmine.clock().install();
    try {
      const enVuelo = servicio.refreshAll();
      expect(peticiones.length).toBe(14);

      // Nadie contesta. El reloj avanza mas alla del timeout y se aborta la peticion.
      jasmine.clock().tick(REQUEST_TIMEOUT_MS + 100);
      await Promise.resolve();
      await enVuelo;

      const estado = servicio.panel('pulso', 'spring');
      // Lo que importa: NO se queda en loading para siempre.
      expect(estado.status).toBe('error');
      expect(estado.note).toContain('no hubo respuesta');
      // Y dice a que endpoint llamo, para poder comprobarlo sin adivinar.
      expect(estado.note).toContain(environment.spring.gateway);
      expect(estado.note).toContain('panel=pulso');

      responderTodas(() => respuesta('x', [], 'n'));
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
    servicio.setComparisonPanel('descartes');
    expect(servicio.comparisonPanel()).toBe('descartes');
    expect(peticiones.length).toBe(2);
    for (const peticion of peticiones.splice(0)) {
      expect(peticion.url).toContain('panel=comparativa');
      expect(peticion.url).toContain('de=descartes');
      peticion.responder({ panel: 'comparativa', de: 'descartes', ts: 'x', stack: 'spring', series: [] });
    }
    await Promise.resolve();
  });

  it('el intervalo configurado esta entre 5 y 10 segundos: educacion con Prometheus', () => {
    expect(environment.metricsIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(environment.metricsIntervalMs).toBeLessThanOrEqual(10000);
  });

  it('start arranca el refresco una sola vez aunque se llame dos veces', () => {
    servicio.start();
    servicio.start();
    expect(peticiones.length).toBe(14);
    responderTodas(() => respuesta('x', [], 'n'));
  });

  it('un ciclo colgado no bloquea los siguientes: se descarta y se empieza otro', () => {
    // Primer ciclo: nadie responde, asi que se queda en vuelo.
    void servicio.refreshAll();
    expect(peticiones.length).toBe(14);

    // Han pasado mas de REQUEST_TIMEOUT_MS + 5 s (se falsea el arranque del ciclo en vez de esperar
    // 15 segundos reales): el siguiente ciclo tiene que poder arrancar igualmente.
    (servicio as unknown as { inicioCiclo: number }).inicioCiclo = Date.now() - (REQUEST_TIMEOUT_MS + 6000);

    void servicio.refreshAll();
    // El ciclo nuevo salio a la red pese a que el anterior sigue colgado (14 + 14 peticiones en
    // vuelo), y quedo constancia de que se descarto un ciclo.
    expect(peticiones.length).toBe(28);
    expect(servicio.descartados).toBe(1);
  });

  it('un panel que aun no se ha pedido devuelve un estado inicial y no revienta', () => {
    const estado = servicio.panel('pulso', 'spring');
    expect(estado.status).toBe('loading');
    expect(estado.data).toBeNull();
    expect(estado.note).toBeNull();
  });
});
