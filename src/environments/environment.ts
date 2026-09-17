/**
 * Configuracion por entorno: las URLs base de los dos stacks, en un solo sitio.
 *
 * El backend corre en un devcontainer con los puertos reenviados al host, por eso el navegador los
 * ve como `localhost`. Para publicar, se copia `environment.production.ts` y se cambian las URLs
 * por las del gateway publico (ver README, seccion "Publishing").
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
    gateway: 'http://localhost:8089',
    analytics: 'http://localhost:8085',
    health: 'http://localhost:8080',
    healthPath: '/actuator/health',
  },
  quarkus: {
    label: 'Quarkus',
    gateway: 'http://localhost:8189',
    analytics: 'http://localhost:8185',
    health: 'http://localhost:8189',
    healthPath: '/q/health',
  },
  metricsIntervalMs: 5000,
  tickWindow: 60,
  defaultAnalyticsSymbol: 'EUR/USD',
  defaultAnalyticsMinutes: 3,
  reconnectMinMs: 1000,
  reconnectMaxMs: 15000,
};
