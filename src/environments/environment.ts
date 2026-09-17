/**
 * Lo poco que cambia entre desarrollo y produccion.
 *
 * Las rutas del backend **no** estan aqui: son parte del contrato y viven en `core/types.ts`. Lo
 * unico que cambia al publicar es cada cuanto se piden los paneles y si el build es de produccion.
 *
 * La app habla siempre con **su propio origen** y el que la sirve hace de proxy (`proxy.conf.json`
 * en desarrollo, `tools/serve-verify.mjs` para el build compilado). Es lo que hace falta en
 * produccion y de paso evita CORS y el lio de que el navegador y el codigo no esten en la misma
 * maquina.
 */
export interface Environment {
  readonly production: boolean;
  /** Cada cuanto se piden los paneles del catalogo (ms). No cada segundo: educacion con Prometheus. */
  readonly pollMs: number;
  /** Simbolo por defecto de la consulta al state store. */
  readonly symbol: string;
  /** Ventana por defecto de esa consulta, en minutos. */
  readonly minutes: number;
}

export const environment: Environment = {
  production: false,
  pollMs: 4000,
  symbol: 'EUR/USD',
  minutes: 3,
};
