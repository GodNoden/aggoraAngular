# Aggora, explicado

Un panel de **solo lectura** que explica que esta haciendo el backend de Aggora: un pipeline de
eventos de mercado de Kafka implementado **dos veces**, una en Spring Boot y otra en Quarkus.

No es un Grafana con otro color. Grafana contesta "cuanto vale esta serie en el tiempo" a quien ya
sabe que significa la serie. Esto contesta otra pregunta: **que esta haciendo el pipeline ahora
mismo, y como se veria si estuviera roto**. Por eso cada panel lleva, al lado del dato, cuatro
frases en lenguaje llano: que estas viendo, por que importa, que es lo normal y que se ve cuando se
rompe. **Los numeros son la evidencia; el texto es el producto.**

La verdad no esta aqui: esta en Kafka (los topics) y en Prometheus (las series). Esta pagina no
escribe nada — el contrato no tiene un solo endpoint de escritura — y no rellena huecos: si un panel
viene vacio, repite la explicacion del backend y no inventa una grafica.

---

## Como se lee la pagina

De arriba abajo:

1. **El camino del dato**, cinco cajas de izquierda a derecha: simulador de mercado → Kafka
   (`market.ticks.raw`) → normalizador → motor de streams → Prometheus y los gateways. Cada caja
   tiene un color segun el dato que le corresponde, y debajo dice en que panel se ve. Es la respuesta
   de un vistazo a "que esta pasando".
2. **El latido**: lo que el gateway empuja por WebSocket cada segundo. La foto por segundo (ultimo
   valor de cada simbolo) y las alertas y posiciones, que no esperan al segundo.
3. **El catalogo**: seis paneles, cada uno una pregunta cerrada a Prometheus. Los paneles con
   leccion asociada traen el comando exacto que la provoca y que hay que ver.
4. **El state store**: la unica consulta que pide el usuario a proposito (`/analytics` en Spring,
   `/q/analytics` en Quarkus), con las ventanas que ha calculado el motor, su VWAP y su volatilidad.

Los paneles del catalogo, en orden:

| Panel | Que contesta | Si se rompe |
|---|---|---|
| `pulso` | cuantos ticks entran y cuantos salen por segundo | la entrada sube y la salida no: el normalizador no da abasto |
| `lag` | cuanto le falta a cada grupo de consumidores | sube y no vuelve; un negativo pequeno es normal |
| `particiones` | el offset de cada particion: el log avanzando | una particion plana es una particion a la que nadie escribe |
| `descartes` | offsets de la DLT y de los topics de reintento | la DLT sube: hay mensajes que no se pudieron procesar |
| `salud` | targets de Prometheus, motor de streams, particiones infrarreplicadas | un motor a 0 con el proceso vivo es la leccion 5 |
| `transacciones` | **nada, a proposito**: esa metrica no existe en este Prometheus | si algun dia trae series, el backend cambio |
| `comparativa` | el mismo panel en los dos stacks, a la vez | una sola linea, o una que se separa del otro stack |

### Las lecciones

Vienen del repositorio del backend y se lanzan **desde una terminal del devcontainer**, nunca desde
esta pagina. La pagina solo observa y explica; donde hay leccion, el panel trae el comando:

```bash
bash scripts/leccion-1-broker-caido.sh      # el lag NO se mueve: lo que cambia esta en salud y descartes
bash scripts/leccion-2-veneno-dlt.sh        # escalon en la DLT y el resto del pipeline sigue
bash scripts/leccion-3-rebalanceo.sh
bash scripts/leccion-4-exactly-once.sh
bash scripts/leccion-5-streams-muerto.sh    # el proceso sigue vivo y el motor se va a 0
```

---

## Como se ejecuta

El backend tiene que estar levantado (Spring en 8089/8085/8080 y Quarkus en 8189/8185). Nada de este
repositorio hace falta para que el backend funcione.

```bash
npm install
npm run build
npm run serve:built        # sirve el build y hace de proxy en http://localhost:4300
```

`serve:built` sirve los ficheros compilados y hace de proxy hacia los servicios, **todo en un solo
origen**: la app habla con su propio host y el puente decide a que servicio va cada prefijo.

```
/api          -> Spring   8089      /ws    -> WebSocket de Spring 8089
/q/api        -> Quarkus  8189      /q/ws  -> WebSocket de Quarkus 8189
/analytics    -> Spring   8085      /q/analytics -> Quarkus 8185
/actuator     -> simulador 8080
```

`/q/analytics` tiene ruta propia porque el gateway de Quarkus (8189) **no** publica la analitica: eso
vive en su servicio del 8185. La pagina pregunta al stack que estas mirando, y en modo "los dos" lo
dice en pantalla en vez de dejar creer que pregunta a los dos.

En desarrollo tambien vale `npm start` (Angular dev server con `proxy.conf.json`): **probado tambien**
con las mismas 34 comprobaciones en vivo, incluida la recarga.

### Parametros de la URL

| Parametro | Que hace |
|---|---|
| `?explicar=0` | pliega las explicaciones y deja solo los datos |

---

## Como se comprueba que funciona

```bash
npm test              # specs (Karma + Edge de Windows)
npm run verify:live   # la app en un navegador de verdad, contra el backend vivo
npm run diag:browser  # consola, red y recarga de un navegador real, desde WSL
```

`verify:live` hace **34 comprobaciones** sobre la pagina pintada — que los paneles traigan datos,
que el panel vacio se explique, que el WebSocket entregue, que las graficas se dibujen, que cada
panel traiga su explicacion, que el cambio a Quarkus funcione con **su** analitica — y las repite
**despues de recargar**, porque recargar fue el sintoma que se llevo por delante una version entera
de esta pagina. Acepta una URL, asi que vale igual contra el build (`npm run serve:built`) o contra
el dev server (`npm start`).

`diag:browser` es la herramienta de investigacion: sirve el build, lanza el navegador de Windows,
pone su puerto de depuracion al alcance de WSL (un rele TCP, porque WSL2 solo reenvia `localhost` en
un sentido), navega, imprime cada linea de consola y cada respuesta HTTP, y **recarga** la misma
pestana para volver a medir. Sale asi:

```
[ 3497 ms] sonda "fresca 3s": respondio en 1 ms
[ 12591 ms] sonda "reload 6s": respondio en 1 ms
[diag] el puente registro 64 peticiones y 64 respuestas 200
```

**Aviso aprendido a golpes:** no saques conclusiones de un `--dump-dom`. Devuelve la pagina cuando
el navegador cree que ya cargo, que en esta app es antes de que los paneles traigan nada, y da
resultados distintos en ejecuciones seguidas. Para eso estan `verify:live` y `diag:browser`.

---

## Como esta construido

Angular 20 sin zone.js (señales), sin libreria de graficas y sin dependencias de mas. Todo el
codigo de la app son doce ficheros:

```
src/app/
  core/
    types.ts        lo que manda el backend, tipado (el contrato)
    api.ts          URLs, un GET con tiempo limite y el parseo defensivo
    catalog.ts      el catalogo cerrado: siete nombres, sondeo en serie, ventana de las graficas
    live.ts         un WebSocket por stack, con reintento creciente y vigilante de apertura
    analytics.ts    la consulta al state store
  ui/
    docs.ts         EL CONTENIDO: que es cada panel, que es normal y que lo rompe
    pieces.ts       la tarjeta con su explicacion, la mini-grafica y el formato
  app.ts/html/css   la pagina: cabecera, diagrama del pipeline, paneles
```

Tres decisiones que se notan:

- **El catalogo es cerrado y se respeta.** El panel es la unica entrada; aqui no se construye
  ninguna consulta. Donde el contrato no llega, la pagina no inventa: dice que no hay dato.
- **Nada espera para siempre.** Cada peticion tiene 10 s de tiempo limite y cada WebSocket un
  vigilante de apertura de 8 s. Una pagina en "cargando" para siempre no distingue "va lento" de "no
  hay nadie", que es justo lo que hay que saber.
- **La explicacion vive en `ui/docs.ts`, separada del dibujo.** Es el material que hay que revisar
  cuando el backend cambie de comportamiento, y no esta atado a ninguna plantilla.

---

## Publicar

`npm run build` deja los estaticos en `dist/aggora-dashboard/browser`. Se pueden subir a cualquier
hosting estatico, pero **el gateway tiene que estar en el mismo origen** que la pagina (un tunel o un
reverse proxy delante de los dos) o hay que cambiar las rutas de `core/types.ts` por URLs absolutas y
anadir el origen a la allowlist de CORS del backend.

Dos cosas que no se resuelven desde este repositorio:

- **HTTPS obliga a `wss://`.** No hay que escribir el esquema en ningun sitio: lo elige `socketUrl()`
  mirando el protocolo de la pagina. Lo que hace falta es TLS delante del gateway.
- **CORS no es autenticacion.** `curl` lee todos los endpoints. Antes de publicar de verdad hace
  falta autenticacion en el borde.

Aviso de tamano: servir los dos stacks es pesado. Si el host es pequeno, publica uno y apaga el
otro; la columna del que falte dara error de red, que es informacion y no una pagina rota.

---

## Lo que esta pagina no puede decir

- No es la fuente de la verdad. Si el gateway se cae, no hay dashboard, pero el pipeline sigue.
- No reconstruye el pasado: la foto del WebSocket es el **ultimo** valor por simbolo y no hay
  reenvio. Un cliente lento se pierde un segundo y se corrige con el siguiente.
- No promete exactly-once en pantalla: eso es del motor y de Kafka, y el panel de transacciones esta
  vacio porque la metrica no existe, no porque falte.
