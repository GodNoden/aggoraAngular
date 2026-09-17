import { analyticsUrl, httpBase, metricsUrl, PageContext, wsBase, wsUrl } from './urls';

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

  /** Un stack con URLs absolutas (gateway en otro host). */
  const ENDPOINTS = {
    label: 'Spring',
    gateway: 'http://localhost:8089',
    analytics: 'http://localhost:8085',
    health: 'http://localhost:8080',
    healthPath: '/actuator/health',
    wsPath: 'http://localhost:8089/ws',
  };

  /**
   * El stack tal y como se configura en desarrollo: rutas del mismo origen, que resuelve el proxy
   * del dev server. Es el caso que importa, porque es el que hace que la app funcione cuando el
   * navegador no corre en la misma maquina que el backend.
   */
  const ENDPOINTS_MISMO_ORIGEN = {
    label: 'Spring',
    gateway: '/api',
    analytics: '/analytics',
    health: '/actuator',
    healthPath: '/health',
    wsPath: '/ws',
  };

  const SIN_BASE = {
    label: 'Spring',
    gateway: '',
    analytics: '',
    health: '',
    healthPath: '',
    wsPath: '/ws',
  };

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

  it('wsUrl usa la ruta del socket, y respeta un gateway en otro host', () => {
    // Ruta relativa: mismo origen que la pagina.
    expect(wsUrl(ENDPOINTS_MISMO_ORIGEN, LOCAL)).toBe('ws://localhost:4200/ws');
    // URL absoluta: el host manda, y el esquema sigue a la pagina (https -> wss).
    expect(wsUrl(ENDPOINTS, LOCAL)).toBe('ws://localhost:8089/ws');
    expect(wsUrl(ENDPOINTS, PUBLICO)).toBe('wss://localhost:8089/ws');
  });

  it('una ruta relativa se resuelve contra el origen de la pagina', () => {
    expect(httpBase('/api', LOCAL)).toBe('http://localhost:4200/api');
    expect(httpBase('/api/', LOCAL)).toBe('http://localhost:4200/api');
    expect(httpBase('/api', PUBLICO)).toBe('https://aggora.example.com/api');
  });

  it('el socket de una ruta relativa sale del mismo origen que la pagina', () => {
    expect(wsUrl(ENDPOINTS_MISMO_ORIGEN, LOCAL)).toBe('ws://localhost:4200/ws');
    // Y en https sigue siendo wss, que es la trampa del despliegue.
    expect(wsUrl(ENDPOINTS_MISMO_ORIGEN, PUBLICO)).toBe('wss://aggora.example.com/ws');
  });

  it('el catalogo de un stack con ruta relativa usa el mismo origen', () => {
    // El origen real de Karma es el que manda: lo que importa es que no haya host ajeno ni doble
    // barra, que es el bug que este test vigila.
    const url = metricsUrl(ENDPOINTS_MISMO_ORIGEN, 'pulso');
    // El origen es el real de la pagina que ejecuta el test (Karma), no el de `LOCAL`: lo que se
    // comprueba es que la ruta se resuelve contra el origen de la pagina, sea cual sea.
    expect(url).toBe(`${location.origin}/api/metrics?panel=pulso`);
    // Regresion: la base del gateway ya trae su ruta, no se le anade otra vez.
    expect(url).not.toContain('/api/api');
    expect(metricsUrl(ENDPOINTS_MISMO_ORIGEN, 'comparativa', 'lag')).toContain('de=lag');
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
