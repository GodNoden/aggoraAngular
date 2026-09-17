/**
 * Entorno de produccion: la app compilada a estaticos y publicada en un hosting.
 *
 * Lo mismo que en desarrollo salvo que **no hay dev server que haga de proxy**, asi que o el gateway
 * publico vive en el mismo host que la pagina (lo normal detras de un tunel o un reverse proxy) o se
 * ponen aqui las URLs absolutas.
 *
 *  - Mismo host (recomendado): deja las bases vacias y sirve `/api`, `/ws`, `/analytics`... desde el
 *    mismo dominio. La app usa el host de la pagina y no hay que reconstruir si cambia el dominio.
 *  - Otro host: escribe la URL completa, por ejemplo `gateway: 'https://aggora.midominio.com'`.
 *    Recuerda anadir el origen publico a la allowlist de CORS del backend y, si la pagina va por
 *    HTTPS, que `wss://` funcione (necesita TLS delante del gateway).
 *  - El otro stack tiene que estar publicado tambien para el modo "both", o su columna saldra con
 *    error de red, que es informacion y no un fallo de la pagina.
 */

import { Environment } from './environment';

export const environment: Environment = {
  production: true,
  spring: {
    label: 'Spring',
    gateway: '/api',
    analytics: '/analytics',
    health: '/actuator',
    healthPath: '/health',
    wsPath: '/ws',
  },
  quarkus: {
    label: 'Quarkus',
    gateway: '/q/api',
    // La consulta interactiva de Quarkus es el servicio del 8185, no su gateway: va por URL
    // completa (en produccion, la del reverse proxy que la publique).
    analytics: 'http://localhost:8185',
    health: '/q',
    healthPath: '/q/health',
    wsPath: '/q/ws',
  },
  metricsIntervalMs: 10000,
  tickWindow: 60,
  defaultAnalyticsSymbol: 'EUR/USD',
  defaultAnalyticsMinutes: 3,
  reconnectMinMs: 1000,
  reconnectMaxMs: 15000,
};
