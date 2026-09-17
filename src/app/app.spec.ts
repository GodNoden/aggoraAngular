import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { appConfig } from './app.config';

/**
 * El shell: que arranque de verdad.
 *
 * Se monta con el `appConfig` real, asi que un provider que falte falla aqui en vez de producir una
 * pagina en negro que nadie sabe explicar.
 */
describe('App', () => {
  const original = globalThis.fetch;

  beforeEach(() => {
    // El shell pide el catalogo al arrancar: se le da un catalogo vacio para no salir a la red.
    (globalThis as { fetch: unknown }).fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ panel: 'x', ts: 't', stack: 'spring', series: [] })),
      } as unknown as Response);
    TestBed.configureTestingModule({ providers: [...appConfig.providers] });
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = original;
  });

  it('arranca con el appConfig real y pinta el titulo y el selector', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('Aggora');
    expect(texto).toContain('Spring Boot');
    expect(texto).toContain('Los dos, en paralelo');
    // Las explicaciones son el producto: tienen que estar.
    expect(texto).toContain('Que estas viendo');
    expect(texto).toContain('Para verlo romperse');
    fixture.destroy();
  });

  it('explica el hueco del panel de transacciones en vez de rellenarlo', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('vacio a proposito');
    fixture.destroy();
  });
});
