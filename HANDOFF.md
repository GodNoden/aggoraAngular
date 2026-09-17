# Handoff: donde esta este panel y por que se reescribio

Escrito para quien lo recoja despues, incluido yo mismo dentro de un tiempo. Es directo a proposito
sobre lo que esta verificado y lo que no, porque en este repositorio se perdieron horas con
afirmaciones seguras que resultaron ser sobre otra cosa.

## La version de una linea

**La app esta reescrita desde cero, funciona y esta verificada en un navegador de verdad contra el
backend vivo: 31 comprobaciones en verde en sesion fresca y despues de recargar, mas 21 specs.**
Su objetivo ya no es "tener todos los paneles", es **explicar en lenguaje llano que esta haciendo el
backend**, con el dato como evidencia al lado de la explicacion.

## Por que se tiro la version anterior

Tenía mucho trabajo encima y no cumplia el proposito. Los tres motivos, por orden de peso:

1. **El contenido explicativo estaba disperso y era secundario.** Habia siete paneles, modo leccion,
   modo verificacion, modo diagnostico, servicio de historial, verificador en pagina... y la
   explicacion de *que hace el backend* vivia repartida entre `panel-docs.ts`, `lessons.ts` y los
   comentarios de cada componente. No habia un sitio donde leer "esto es lo que hace el pipeline".
2. **El andamiaje tapaba el producto.** `?diag=1`, `?verify=1`, la sonda de red en `index.html`, la
   traza de arranque, el contador de ciclos... todo eso existia porque una vez hubo un fallo, y se
   quedo. Cuando algo fallaba, la mitad de la pagina era instrumentacion y la otra mitad paneles.
3. **Un fallo real de esa version costo horas y no era del backend.** Un `effect()` que leia su
   propia señal y escribia en ella dejaba el hilo principal ocupado para siempre: los paneles se
   quedaban en `loading` con la red perfecta. Ese fallo esta documentado en el historial de git
   (`fix(core): el efecto del historial ya no lee la senal que escribe`) y la leccion se conservo:
   **nunca leas dentro de un efecto la señal que ese efecto escribe.**

La regla que sale de ahi y que se aplico en la reescritura: **si una pieza no ayuda a entender el
backend, no se escribe.**

## Que hace ahora, y como se lee

El orden de la pagina es el del pipeline, no el del catalogo:

1. **El camino del dato**: cinco cajas (simulador → Kafka → normalizador → motor de streams →
   Prometheus y gateways). Cada caja se pone en verde, ambar o rojo **sola**, mirando el dato que le
   corresponde. Es la respuesta de un vistazo a "que esta pasando ahora".
2. **El latido** (WebSocket): la foto por segundo y las alertas y posiciones.
3. **El catalogo**: seis paneles, cada uno una pregunta cerrada a Prometheus. Cada uno lleva cuatro
   frases: que estas viendo, por que importa, **que es normal** y **que se ve cuando se rompe**. Los
   tres paneles con leccion traen el comando exacto y que hay que observar.
4. **El state store**: la unica consulta que el usuario pide a proposito.

El contenido esta en `src/app/ui/docs.ts`, separado del dibujo. **Ahi es donde se mantiene la
explicacion**; si el backend cambia de comportamiento, ese es el fichero que hay que tocar.

## Lo que esta verificado (y como)

- `npm run build` en verde. Bundle inicial 174 kB (50 kB de transferencia).
- `npm test`: **21 specs**. Cubren el parseo defensivo (un frame roto no tumba la pagina), el
  catalogo (vacio **con nota** es informacion; un 502 es averia y dice donde llamo), la ventana de
  las graficas (no repite valores) y el arranque del shell con el `appConfig` real.
- `npm run verify:live`: **31/31 en verde**, y es lo importante. Sobre la pagina pintada por un
  navegador de verdad contra el backend vivo, en sesion fresca **y despues de recargar**:
  - 9 tarjetas, 5 etapas del diagrama, 16 estados `ok` (una por panel y stack), 0 pidiendo, 0 errores;
  - 38 trazos de grafica, 12 simbolos en la foto, alertas y posiciones llegando;
  - 2 ventanas del state store;
  - 9 bloques de explicacion y 3 comandos de leccion en pantalla.
- Probado tambien a mano el selector: Spring (9 tarjetas), **los dos en paralelo** (19 tarjetas, 4
  titulos de columna, el selector de comparativa) y Quarkus (9 tarjetas, 0 errores).

Un fallo real que salio en esta reescritura, y que conviene recordar: la primera version construia
`/analytics/analytics` (404). Es **el mismo error que ya habia cometido la version anterior**, asi
que ahora hay dos specs que fijan las URLs exactas.

## El entorno, que sigue siendo la parte dificil

- El repositorio vive en **WSL**; el navegador es de **Windows**. `localhost` no es el mismo host en
  los dos lados, y por eso la app habla siempre con **su propio origen** y quien la sirve hace de
  proxy (el dev server en desarrollo, `tools/serve-verify.mjs` para el build).
- **El puerto de depuracion del navegador no se alcanza desde WSL.** WSL2 reenvia `localhost` en un
  solo sentido (Windows → WSL). `tools/tcp-relay.mjs` lo pone al alcance con un PowerShell que copia
  bytes; encima habla `tools/cdp.mjs`, un cliente minimo del protocolo de depuracion sin
  dependencias. De ahi salen `npm run verify:live` y `npm run diag:browser`.
- No hay Chrome ni en WSL ni en Windows: se usa Edge. `karma.conf.js` y `tools/browser.mjs` lo
  encuentran solos, y traducen `--user-data-dir` a una ruta de Windows (sin eso el navegador arranca
  y muere con codigo 21).

## Lo que queda abierto (no son fallos, son decisiones)

1. **La consulta al state store solo pregunta a Spring.** Quarkus tiene su propio `/analytics` en el
   8185, pero en `core/types.ts` los dos stacks apuntan al mismo camino del proxy. Si se quiere
   comparar, hay que publicar el de Quarkus y darle su prefijo.
2. **`salud` solo publica el motor de Spring** (`spring/analytics-streams`); Quarkus no tiene
   contrapartida en esta Prometheus. La pagina no lo rellena: ese grupo simplemente no aparece. Esta
   anotado en el texto del panel.
3. **`comparativa` etiqueta las series como `spring` y `quarkus`**, no como `spring/...` (el README
   del backend dice lo segundo). La pagina pinta lo que llega.
4. **`salud` trae ~90 series**, 82 de ellas `under-replicated/prueba.*` en cero. Se pliegan en un
   contador para que no tapen la señal.
5. **No hay autenticacion.** CORS no es autenticacion: `curl` lee todos los endpoints.
6. **`ng serve` no se ha vuelto a verificar** tras la reescritura. El camino probado es el build
   compilado con `serve:built`.

## Trampas que ya costaron tiempo aqui

- **No uses `--dump-dom` para comprobar la pagina.** Devuelve el HTML cuando el navegador cree que ya
  cargo, que es **antes** de que los paneles traigan datos (se piden de uno en uno). Da resultados
  distintos en ejecuciones seguidas. `tools/dump-dom.mjs` existe pero avisa de esto al terminar.
- **No leas dentro de un efecto la señal que ese efecto escribe.** Si el efecto necesita su propio
  estado, guardalo en un campo normal, no en una señal.
- **No escribas el DOM a mano desde un hook de ciclo de vida.** En esta version de Angular,
  `ngDoCheck` y `ngAfterViewChecked` pueden dejar de ejecutarse mientras la vista sigue
  refrescandose (medido: el reloj avanzaba y el contador se quedaba en 2). Si necesitas un informe,
  que sea una señal que pinta la plantilla.
- **No rellenes un panel vacio.** Si el catalogo devuelve `series: []` con una `nota`, eso es
  informacion: se repite la nota y no se dibuja nada.
