import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/*
 * Arranque de la app.
 *
 * Si el arranque falla, el error se deja tambien en el DOM (`#boot-errors`, ver `index.html`): una
 * pantalla en negro sin explicacion es lo peor que puede pasar en un dashboard, y en este equipo el
 * navegador corre en Windows mientras el codigo vive en WSL, asi que la consola no siempre esta a
 * mano. El `catch` no se traga nada: registra y avisa.
 */
bootstrapApplication(App, appConfig)
  .then(() => {
    const global = globalThis as { __aggoraTrace?: string[] };
    global.__aggoraTrace = global.__aggoraTrace ?? [];
    global.__aggoraTrace.push(`${Math.round(performance.now())} ms  main: bootstrap resuelto (App creado)`);
    console.info('[aggora] bootstrap OK a los', Math.round(performance.now()), 'ms');
  }).catch((error) => {
  console.error(error);
  if (typeof document !== 'undefined') {
    const aviso = document.createElement('pre');
    aviso.id = 'boot-errors';
    aviso.setAttribute('data-boot', 'fail');
    aviso.style.cssText =
      'margin:16px;padding:12px;border:1px solid #7f1d1d;border-radius:8px;background:#1b1114;color:#ffb4c0;font:12px/1.5 monospace;white-space:pre-wrap;';
    aviso.textContent = `The dashboard did not start:\n${String(error?.message ?? error)}`;
    document.body.appendChild(aviso);
  }
});
