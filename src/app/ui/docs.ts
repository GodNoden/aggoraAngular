/**
 * El contenido de la pagina. Esto es el producto.
 *
 * Un panel = una cosa que hace el backend. Para cada uno, cuatro frases en lenguaje llano:
 *
 *   `queVes`    que estas mirando, en una linea.
 *   `porQue`    por que importa: que decision se toma con ese dato.
 *   `normal`    que es "sano", para poder reconocerlo sin saber nada del sistema.
 *   `roto`      que se ve cuando esa pieza falla.
 *
 * Y donde hay una leccion que lo provoca, el comando exacto y el panel que hay que vigilar. Las
 * lecciones se lanzan **desde una terminal del devcontainer**, nunca desde esta pagina: la pagina
 * solo observa y explica.
 */

export interface Lesson {
  /** El comando tal cual se copia en la terminal. */
  readonly command: string;
  /** Que hace ese comando, en una linea. */
  readonly does: string;
  /** Que hay que ver en este panel cuando se ejecute. */
  readonly expect: string;
}

export interface PanelDoc {
  /** Nombre tecnico: es el valor de `?panel=` y la clave del panel. */
  readonly name: string;
  /** Titulo para la pantalla. */
  readonly title: string;
  /** El dato que se pide al catalogo, en palabras. */
  readonly ask: string;
  readonly queVes: string;
  readonly porQue: string;
  readonly normal: string;
  readonly roto: string;
  readonly lesson?: Lesson;
}

/** Los paneles del catalogo, en el orden en que se leen: del latido a la letra pequena. */
export const DOCS: readonly PanelDoc[] = [
  {
    name: 'pulso',
    title: 'Cuantos ticks entran y cuantos salen',
    ask: 'ticks por segundo hacia market.ticks.raw (entrada) y fuera de los topics canonicos (salida)',
    queVes:
      'El caudal del pipeline. Entran ticks crudos del mercado y salen convertidos en el topic canonico, que es el que consumen los demas.',
    porQue:
      'Es el semaforo del sistema. Si lo que entra sube y lo que sale no sube con ello, el normalizador no da abasto: el trabajo se acumula en Kafka en vez de desaparecer.',
    normal:
      'Las dos lineas suben y bajan juntas, casi pegadas. La entrada es un poco mayor que la salida porque un mismo simbolo se colapsa en un solo valor.',
    roto: 'La entrada sube y la salida se queda plana o a cero: se dejo de normalizar.',
  },
  {
    name: 'lag',
    title: 'Cuanto le falta a cada consumidor',
    ask: 'retraso de cada grupo de consumidores respecto al final del log',
    queVes:
      'Cada grupo de consumidores lee a su ritmo. El lag es cuantos mensajes le faltan para ponerse al dia con el final del log.',
    porQue:
      'Es lo primero que se degrada cuando algo no da abasto, y es la unica senal que dice "se esta acumulando trabajo" antes de que se note en los datos.',
    normal:
      'Cerca de cero y oscilando: sube un poco con el pico y vuelve. La forma sana es una sierra que vuelve siempre al suelo.',
    roto: 'Sube y no vuelve. Un numero pequeno negativo (por ejemplo -3) tambien es normal: es el instante en que el consumidor va por delante del ultimo offset confirmado.',
    lesson: {
      command: 'bash scripts/leccion-1-broker-caido.sh',
      does: 'Apaga un broker de Kafka.',
      expect:
        'La leccion 1 es la trampa: el lag NO se mueve. Kafka reparte las particiones entre las copias que quedan y el consumo sigue. Lo que cambia esta en Salud (particiones infrarreplicadas) y en Descartes.',
    },
  },
  {
    name: 'particiones',
    title: 'El log avanzando, particion a particion',
    ask: 'offset actual de cada particion de cada topic',
    queVes:
      'Un topic de Kafka se parte en particiones y cada una es un log al que solo se anade por el final. Esto es el contador de cada una: hasta donde ha llegado.',
    porQue:
      'Es la prueba de que el dato esta entrando y de como se reparte. Un offset es un contador absoluto: solo puede subir.',
    normal:
      'Todas suben. Spring y Quarkus escriben en topics distintos (market.ticks.canonical y market.ticks.canonical.q); las dos columnas avanzan al mismo ritmo porque hacen el mismo trabajo.',
    roto: 'Una particion plana es una particion a la que nadie escribe. Un salto grande es una rafaga de golpe.',
  },
  {
    name: 'descartes',
    title: 'Lo que no se pudo procesar',
    ask: 'offsets de los topics de descarte (DLT) y de reintento',
    queVes:
      'Cuando un mensaje no se puede procesar, no se tira: se aparca en un topic aparte (DLT) con el motivo en una cabecera. Los topics de reintento son los que se vuelven a intentar.',
    porQue:
      'Es la papelera con registro. Un mensaje en la DLT no se ha perdido, pero tampoco ha llegado a su destino, y eso hay que verlo.',
    normal: 'Todo plano. Los topics de reintento pueden moverse algo; la DLT, no.',
    roto: 'La DLT sube: hay mensajes que no se pudieron procesar. Un escalon en un topic de reintento sin que suba la DLT significa que el reintento esta funcionando.',
    lesson: {
      command: 'bash scripts/leccion-2-veneno-dlt.sh',
      does: 'Manda un mensaje envenenado: uno que el normalizador no puede interpretar.',
      expect:
        'El offset de market.ticks.raw.DLT da un escalon y se queda ahi. El resto del pipeline sigue: un mensaje malo no puede parar la linea.',
    },
  },
  {
    name: 'salud',
    title: 'Quien esta vivo y quien solo lo parece',
    ask: 'estado de cada target de Prometheus, el motor de Kafka Streams por stack y particiones infrarreplicadas',
    queVes:
      'Tres comprobaciones distintas: si Prometheus consigue sondear cada servicio, si el motor de streams esta corriendo dentro de cada stack, y cuantas particiones tienen menos copias de las que deberian.',
    porQue:
      'Un proceso puede estar vivo y su motor estar muerto, y entonces el proceso responde pero no procesa nada. Esta es la unica parte de la pagina que distingue "arriba" de "funcionando".',
    normal:
      'Todos los targets a 1, el motor del stack a 1 y cero particiones infrarreplicadas. En este entorno hay decenas de topics de prueba en cero: se cuentan en una linea en vez de listarlos, porque taparian la senal. Si un stack no publica su motor, ese grupo no aparece: la pagina no lo rellena.',
    roto: 'Un target a 0, un motor a 0 con el proceso vivo, o particiones infrarreplicadas. Cada uno apunta a un sitio distinto.',
    lesson: {
      command: 'bash scripts/leccion-5-streams-muerto.sh',
      does: 'Mata el motor de streams sin matar el proceso.',
      expect:
        'El target sigue a 1 (el proceso responde) pero aggora_kafka_streams_running se va a 0. Es la diferencia entre la sonda de salud y la lista de procesos.',
    },
  },
  {
    name: 'transacciones',
    title: 'Transacciones confirmadas y abortadas',
    ask: 'un contador que este Prometheus no publica',
    queVes:
      'Nada, y no es un fallo de la pagina: este panel viene vacio a proposito, con la explicacion del backend.',
    porQue:
      'Existir no es lo mismo que estar medido. Ensenar el hueco, en vez de rellenarlo con una grafica vacia, es parte del trabajo.',
    normal: 'El hueco con su nota. Always.',
    roto: 'Si algun dia trae series, el backend cambio: la pagina las pintara, pero antes hay que leer la nota.',
  },
];

/** El panel de comparacion: no es un panel mas, es el modo de mirar dos veces lo mismo. */
export const COMPARISON: PanelDoc = {
  name: 'comparativa',
  title: 'Los dos, uno al lado del otro',
  ask: 'el mismo panel en Spring y en Quarkus, agregado por stack',
  queVes:
    'El proyecto es el mismo pipeline escrito dos veces. Aqui se piden a la vez las series de Spring y las de Quarkus y se ponen juntas.',
  porQue:
    'Es la gracia del proyecto: lo que importa no es que las dos lineas existan, es que tengan la misma forma. Una que se separa es la divergencia que hay que perseguir.',
  normal:
    'Las dos lineas pegadas, una por stack. Los nombres son los de la implementacion (spring, quarkus), y cada una escribe en su propio topic.',
  roto:
    'Una sola linea, o una que se separa. Si solo viene una, el backend no tiene esa serie para ese stack y la pagina lo dice en vez de fingir que falta un dato.',
};
