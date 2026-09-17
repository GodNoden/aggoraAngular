import { TestBed } from '@angular/core/testing';
import { SeriesHistoryService } from './series-history.service';
import { MetricsService, PanelState } from './metrics.service';
import { PANELS, PanelName, Stack } from './contract';

/**
 * Pruebas de la ventana movil de las series.
 *
 * Existen por un fallo real que costo horas: el `effect()` del servicio leia `historial()` (su propia
 * senal) para saber el ultimo valor guardado y luego escribia en ella. Un efecto que lee y escribe la
 * misma senal se alimenta a si mismo; en el navegador no salta el error de "bucle infinito" de
 * Angular y el hilo principal se queda sin turno, con la pagina en `loading` para siempre y el
 * renderer bloqueado. La red, el catalogo y el WebSocket estaban bien: el culpable era esta linea.
 *
 * El test comprueba la propiedad que lo evita: **el efecto solo depende de `panels()`**. Si vuelve a
 * depender de `historial`, cada vuelta se reprograma y el contador de ejecuciones se dispara.
 */
describe('SeriesHistoryService', () => {
  let servicio: SeriesHistoryService;
  let metrics: MetricsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    metrics = TestBed.inject(MetricsService);
    servicio = TestBed.inject(SeriesHistoryService);
  });

  afterEach(() => {
    metrics.stop();
  });

  /** Mete a mano el estado de un panel, como si el catalogo acabara de responder. */
  function publicar(panel: PanelName, stack: Stack, valores: readonly number[]): void {
    const series = valores.map((valor, indice) => ({
      label: `serie-${indice}`,
      points: [[1_700_000_000 + indice, valor]] as const,
    }));
    const datos = {
      panel,
      ts: new Date().toISOString(),
      stack,
      series,
    };
    const estado = metrics as unknown as {
      escribir: (panel: PanelName, stack: Stack, cambio: Partial<PanelState>) => void;
    };
    estado.escribir(panel, stack, {
      status: 'ok',
      data: datos,
      fetchedAt: Date.now(),
    });
  }

  it('guarda un punto por serie y no se alimenta de su propia senal', () => {
    publicar('lag', 'spring', [10, 20]);
    TestBed.flushEffects();
    expect(servicio.vueltasDelEfecto()).toBe(1);
    expect(servicio.values('lag', 'spring', 'serie-0')).toEqual([10]);
    expect(servicio.values('lag', 'spring', 'serie-1')).toEqual([20]);

    // El efecto ha corrido exactamente una vez. Si dependiera de `historial` (su propia senal),
    // correria otra vez por cada vuelta y este numero subiria.
    expect(servicio.vueltasDelEfecto()).toBe(1);

    // Y correr sin que los paneles cambien no anade nada: la ventana no se llena de repetidos.
    TestBed.flushEffects();
    TestBed.flushEffects();
    expect(servicio.values('lag', 'spring', 'serie-0')).toEqual([10]);
    expect(servicio.values('lag', 'spring', 'serie-1')).toEqual([20]);

    publicar('lag', 'spring', [30, 40]);
    TestBed.flushEffects();
    expect(servicio.values('lag', 'spring', 'serie-0')).toEqual([10, 30]);
    expect(servicio.values('lag', 'spring', 'serie-1')).toEqual([20, 40]);
  });

  it('no repite un valor que no ha cambiado, aunque el panel se refresque', () => {
    publicar('pulso', 'spring', [5]);
    TestBed.flushEffects();
    publicar('pulso', 'spring', [5]);
    TestBed.flushEffects();
    publicar('pulso', 'spring', [5]);
    TestBed.flushEffects();
    expect(servicio.values('pulso', 'spring', 'serie-0')).toEqual([5]);
  });

  it('la ventana esta acotada: no crece sin fin', () => {
    for (let vuelta = 0; vuelta < 80; vuelta += 1) {
      publicar('particiones', 'spring', [vuelta]);
      TestBed.flushEffects();
    }
    const ventana = servicio.values('particiones', 'spring', 'serie-0');
    expect(ventana.length).toBe(60);
    // Se queda con los ultimos: la ventana es reciente, no un log.
    expect(ventana.at(-1)).toBe(79);
  });

  it('un panel sin datos no entra en la ventana', () => {
    TestBed.flushEffects();
    expect(servicio.seriesConHistoria()).toBe(0);
    expect(servicio.values('salud', 'quarkus', 'target')).toEqual([]);
  });

  it('tolera todas las etiquetas del catalogo sin romperse', () => {
    for (const panel of PANELS) {
      publicar(panel, 'spring', [1]);
      publicar(panel, 'quarkus', [2]);
    }
    TestBed.flushEffects();
    for (const panel of PANELS) {
      expect(servicio.values(panel, 'spring', 'serie-0')).toEqual([1]);
      expect(servicio.values(panel, 'quarkus', 'serie-0')).toEqual([2]);
    }
  });
});
