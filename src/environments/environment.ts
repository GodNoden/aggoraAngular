/**
 * Configuracion por entorno: las rutas de los dos stacks, en un solo sitio.
 *
 * **Todo es del mismo origen que la pagina**, y eso es a proposito. En desarrollo la app la sirve
 * `ng serve` en `localhost:4200` y el dev server hace de proxy hacia los servicios
 * (`proxy.conf.json`): `/api` -> Spring 8089, `/api-q` -> Quarkus 8189, `/analytics` -> 8085,
 * `/ws` y `/ws-q` -> los dos WebSocket.
 *
 * Por que no se apunta directamente a `localhost:8089`: porque el navegador no siempre corre en la
 * misma maquina que el codigo. Aqui la app vive en WSL y el navegador es el de Windows, y desde ahi
 * `localhost:8089` **no** es el host donde escucha el gateway. Con el proxy, el navegador solo habla
 * con `localhost:4200` y el salto lo da el dev server, que si esta en el mismo sitio que el backend.
 * De propina, en desarrollo no hace falta CORS.
 */

import { StackEndpoints } from '../app/core/contract';

export interface Environment {
  readonly production: boolean;
  readonly spring: StackEndpoints;
  readonly quarkus: StackEndpoints;
  /** Cada cuanto se piden los paneles de metricas (ms). No cada segundo: educacion con Prometheus. */
  readonly metricsIntervalMs: number;
  /** Cuantos puntos guarda la ventana movil de las graficas (1 snapshot por segundo). */
  readonly tickWindow: number;
  /** Simbolo por defecto de la consulta interactiva. */
  readonly defaultAnalyticsSymbol: string;
  /** Ventana por defecto de la consulta interactiva, en minutos. */
  readonly defaultAnalyticsMinutes: number;
  /** Espera minima y maxima entre reintentos del WebSocket (ms), con espera creciente. */
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
}

export const environment: Environment = {
  production: false,
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
  metricsIntervalMs: 5000,
  tickWindow: 60,
  defaultAnalyticsSymbol: 'EUR/USD',
  defaultAnalyticsMinutes: 3,
  reconnectMinMs: 1000,
  reconnectMaxMs: 15000,
};
