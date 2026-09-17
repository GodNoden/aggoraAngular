/**
 * Entorno de produccion: la app compilada a estaticos y publicada en un hosting.
 *
 * Lo unico que cambia respecto a `environment.ts` son las URLs: apuntan al gateway publico detras
 * de TLS. Detalles importantes (ver README):
 *
 *  - Si la pagina se sirve por HTTPS, el navegador BLOQUEA `ws://`. Por eso `wsUrl()` elige `wss://`
 *    solo cuando `location.protocol === 'https:'`. Aqui no se escribe el esquema a mano.
 *  - Si el gateway publico y la pagina comparten dominio (tunel o reverse proxy en el mismo host),
 *    deja `gateway: ''`: la app usa el host de la pagina para HTTP y WebSocket. Asi no hay que
 *    reconstruir el bundle al cambiar de dominio.
 *  - El otro stack tiene que estar publicado tambien para el modo "both", o su columna saldra con
 *    error de red (que es informacion, no un fallo de la pagina).
 */

import { Environment } from './environment';

export const environment: Environment = {
  production: true,
  spring: {
    label: 'Spring',
    gateway: '',
    analytics: '',
    health: '',
    healthPath: '/actuator/health',
  },
  quarkus: {
    label: 'Quarkus',
    gateway: '',
    analytics: '',
    health: '',
    healthPath: '/q/health',
  },
  metricsIntervalMs: 10000,
  tickWindow: 60,
  defaultAnalyticsSymbol: 'EUR/USD',
  defaultAnalyticsMinutes: 3,
  reconnectMinMs: 1000,
  reconnectMaxMs: 15000,
};
