import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';

/**
 * Configuracion de la aplicacion.
 *
 * Lo unico que se registra aqui son las piezas de Angular que el dashboard usa de verdad:
 *
 *  - `provideHttpClient()`: sin esto, `MetricsService` y `AnalyticsService` no pueden inyectar
 *    `HttpClient` y Angular falla al arrancar con `NG0201`. No es un detalle opcional: **es la app
 *    entera**, porque todo lo que no llega por WebSocket llega por GET. `withFetch()` usa la API
 *    `fetch` del navegador en vez de `XMLHttpRequest`.
 *  - Deteccion de cambios con zone.js y coalescing: sigue siendo la opcion por defecto mas simple y
 *    la app no necesita nada mas (ni NgRx ni un store: signals y RxJS bastan).
 *  - `provideBrowserGlobalErrorListeners()`: los errores de runtime se ven en la consola en vez de
 *    quedarse en silencio.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(withFetch()),
  ],
};
