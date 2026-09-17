/**
 * Produccion: lo mismo, pidiendo los paneles un poco menos a menudo.
 *
 * Aqui **no hay dev server que haga de proxy**, asi que el gateway publicado tiene que estar en el
 * mismo host que la pagina (lo normal detras de un tunel o un reverse proxy) o hay que cambiar las
 * rutas de `core/types.ts` por URLs absolutas y anadir el origen publico a la allowlist de CORS del
 * backend. Si la pagina va por HTTPS, el WebSocket sale como `wss://` solo: lo decide `socketUrl()`
 * mirando el protocolo de la pagina, no una constante.
 */
import { Environment } from './environment';

export const environment: Environment = {
  production: true,
  pollMs: 8000,
  symbol: 'EUR/USD',
  minutes: 3,
};
