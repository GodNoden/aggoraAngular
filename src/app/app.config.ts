import { provideHttpClient } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';

/**
 * Configuracion de la aplicacion.
 *
 *  - `provideZonelessChangeDetection()`: **sin zone.js**. La app usa signals, asi que Angular sabe
 *    exactamente que ha cambiado y no necesita que una libreria parchee `fetch`, `WebSocket` y
 *    `setTimeout` para enterarse. Ademas de ser la direccion en la que va Angular, aqui hubo un
 *    motivo concreto: con zone.js todas las peticiones de la app se quedaban sin resolver en este
 *    entorno, mientras la misma peticion hecha con la API nativa (la sonda de `index.html`)
 *    respondia en milisegundos.
 *  - `provideHttpClient()`: sin esto, `MetricsService` y `AnalyticsService` no pueden inyectar
 *    `HttpClient` y Angular falla al arrancar con `NG0201`. Es la app entera: todo lo que no llega
 *    por WebSocket llega por GET. Se usa el backend XHR (el de por defecto) y no `withFetch()`.
 *  - `provideBrowserGlobalErrorListeners()`: los errores de runtime se ven en la consola en vez de
 *    quedarse en silencio.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(),
  ],
};
