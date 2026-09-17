import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';

/**
 * Arranque de la app.
 *
 *  - `provideZonelessChangeDetection()`: sin zone.js. La app usa señales, asi que Angular sabe que ha
 *    cambiado sin que una libreria parchee `fetch`, `WebSocket` y `setTimeout`.
 *  - `provideBrowserGlobalErrorListeners()`: un error de runtime se ve en la consola en vez de
 *    quedarse en silencio.
 *
 * No hay `provideHttpClient()` porque la app no usa `HttpClient`: habla con `fetch` desde
 * `core/api.ts`, que es donde vive el tiempo limite de cada peticion.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()],
};
