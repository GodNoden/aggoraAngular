import { analyticsUrl, httpBase, PageContext, wsBase, wsUrl } from './urls';

/**
 * El esquema del WebSocket se elige, no se escribe a mano.
 *
 * Es la trampa del despliegue: una pagina servida por HTTPS **no puede** abrir `ws://` (contenido
 * mixto, el navegador lo bloquea). Estas pruebas fijan que `wsBase` cambia de `ws` a `wss` siguiendo
 * el protocolo de la pagina y que una base vacia significa "el mismo host que sirve la pagina", que
 * es lo que permite publicar detras de un tunel sin recompilar.
 *
 * El contexto de la pagina se pasa como parametro en vez de reescribir `window.location`: en un
 * navegador real esa propiedad es de solo lectura, y un test que se pelea con el navegador acaba
 * probando el test y no el codigo.
 */
describe('urls', () => {
  const LOCAL: PageContext = { protocol: 'http:', origin: 'http://localhost:4200' };
  const PUBLICO: PageContext = { protocol: 'https:', origin: 'https://aggora.example.com' };

  const ENDPOINTS = {
    label: 'Spring',
    gateway: 'http://localhost:8089',
    analytics: 'http://localhost:8085',
    health: 'http://localhost:8080',
    healthPath: '/actuator/health',
  };

  const SIN_BASE = { label: 'Spring', gateway: '', analytics: '', health: '', healthPath: '' };

  it('httpBase devuelve la base tal cual, sin barra final', () => {
    expect(httpBase('http://localhost:8089', LOCAL)).toBe('http://localhost:8089');
    expect(httpBase('http://localhost:8089/', LOCAL)).toBe('http://localhost:8089');
  });

  it('una base vacia significa el host de la pagina', () => {
    expect(httpBase('', PUBLICO)).toBe('https://aggora.example.com');
    expect(httpBase('', LOCAL)).toBe('http://localhost:4200');
  });

  it('en local usa ws://', () => {
    expect(wsBase('http://localhost:8089', LOCAL)).toBe('ws://localhost:8089');
  });

  it('con https la pagina obliga a wss:// (si no, el navegador lo bloquea)', () => {
    expect(wsBase('http://localhost:8089', PUBLICO)).toBe('wss://localhost:8089');
    // Una base https se convierte en wss conservando el host.
    expect(wsBase('https://aggora.midominio.com', PUBLICO)).toBe('wss://aggora.midominio.com');
  });

  it('con la pagina en https y base vacia, el socket va al mismo host por wss', () => {
    expect(wsUrl(SIN_BASE, PUBLICO)).toBe('wss://aggora.example.com/ws');
  });

  it('en local, base vacia apunta al host de la pagina por ws', () => {
    expect(wsUrl(SIN_BASE, LOCAL)).toBe('ws://localhost:4200/ws');
  });

  it('wsUrl anade la ruta /ws del contrato y respeta el puerto del stack', () => {
    expect(wsUrl(ENDPOINTS, LOCAL)).toBe('ws://localhost:8089/ws');
    expect(wsUrl({ ...ENDPOINTS, gateway: 'http://localhost:8189' }, LOCAL)).toBe(
      'ws://localhost:8189/ws',
    );
  });

  it('analyticsUrl codifica el simbolo: EUR/USD lleva barra', () => {
    const url = analyticsUrl(ENDPOINTS, 'EUR/USD', 3);
    expect(url).toBe('http://localhost:8085/analytics?symbol=EUR%2FUSD&minutes=3');
  });

  it('analyticsUrl tambien codifica minutos y simbolos raros', () => {
    const url = analyticsUrl(ENDPOINTS, 'A B&C', 15);
    expect(url).toContain('symbol=A+B%26C');
    expect(url).toContain('minutes=15');
  });
});
