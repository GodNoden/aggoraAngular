/**
 * El canal en vivo: un WebSocket por stack.
 *
 * Es la unica via por la que el backend **empuja** datos en vez de esperar a que se los pidan, y es
 * el unico canal por segundo. Dos cosas que hay que tener claras y que la pagina ensena:
 *
 *  1. **No hay reenvio.** Es un fan-out: si el cliente se pierde un segundo, ese segundo no vuelve.
 *     Se corrige con la siguiente foto. Por eso aqui no hay cola ni historial: solo el ultimo estado
 *     y una ventana corta para la forma reciente.
 *  2. **`snapshot` es el ultimo valor de cada simbolo**, no una lista de ticks. Un simbolo que deja
 *     de cotizar mantiene su ultimo precio, y lo que delata que se paro es su antiguedad.
 */

import { Injectable, computed, signal } from '@angular/core';
import { parseFrame, socketUrl } from './api';
import { Alert, Position, STACKS, Snapshot, Stack } from './types';

/** Cuantos segundos de ventana se guardan para las graficas (uno por snapshot). */
const VENTANA = 60;
/** Cuantas alertas y posiciones se conservan en pantalla. */
const MAX_ALERTAS = 40;
const MAX_POSICIONES = 50;
/** Si un socket no abre en este tiempo, se corta y se reintenta (ms). */
const ESPERA_APERTURA_MS = 8000;

export type SocketState = 'parado' | 'conectando' | 'abierto' | 'reintentando';

export interface Live {
  readonly state: SocketState;
  readonly intentos: number;
  readonly snapshot: Snapshot | null;
  /** Ventana corta: `[ticksIn, ticksOut]` por segundo recibido. */
  readonly window: readonly (readonly [number, number])[];
  readonly alerts: readonly Alert[];
  readonly positions: readonly Position[];
  /** Mensajes recibidos por tipo. */
  readonly counters: Readonly<Record<string, number>>;
  /** Un frame que no cuadraba con el contrato, para poder decirlo en pantalla. */
  readonly badFrame: { readonly raw: string; readonly at: number } | null;
  readonly lastAt: number | null;
}

const INICIAL: Live = {
  state: 'parado',
  intentos: 0,
  snapshot: null,
  window: [],
  alerts: [],
  positions: [],
  counters: {},
  badFrame: null,
  lastAt: null,
};

@Injectable({ providedIn: 'root' })
export class LiveFeed {
  private readonly estados = signal<Readonly<Record<Stack, Live>>>({
    spring: INICIAL,
    quarkus: INICIAL,
  });

  private readonly sockets = new Map<Stack, WebSocket>();
  private readonly reintentos = new Map<Stack, ReturnType<typeof setTimeout>>();
  private readonly vigilantes = new Map<Stack, ReturnType<typeof setTimeout>>();
  private parado = true;

  readonly state = this.estados.asReadonly();

  /** Mensajes recibidos entre los dos stacks. */
  readonly mensajes = computed(() =>
    STACKS.reduce(
      (total, stack) =>
        total +
        Object.values(this.estados()[stack].counters).reduce((suma, valor) => suma + valor, 0),
      0,
    ),
  );

  start(): void {
    this.parado = false;
    for (const stack of STACKS) {
      this.conectar(stack);
    }
  }

  stop(): void {
    this.parado = true;
    for (const stack of STACKS) {
      const reintento = this.reintentos.get(stack);
      if (reintento) {
        clearTimeout(reintento);
        this.reintentos.delete(stack);
      }
      this.cancelarVigilante(stack);
      const socket = this.sockets.get(stack);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* ya estaba cerrado */
        }
        this.sockets.delete(stack);
      }
    }
  }

  /** Reconecta ya, sin esperar al reintento programado. */
  reconectar(stack: Stack): void {
    const reintento = this.reintentos.get(stack);
    if (reintento) {
      clearTimeout(reintento);
      this.reintentos.delete(stack);
    }
    this.cancelarVigilante(stack);
    const socket = this.sockets.get(stack);
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* ignorado */
      }
      this.sockets.delete(stack);
    }
    this.conectar(stack);
  }

  private conectar(stack: Stack): void {
    if (this.parado || this.sockets.has(stack)) {
      return;
    }
    this.update(stack, (estado) => ({
      ...estado,
      state: estado.snapshot ? 'reintentando' : 'conectando',
    }));

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(stack));
    } catch {
      this.programarReintento(stack);
      return;
    }
    this.sockets.set(stack, socket);

    // Vigilante: un socket que se queda en CONNECTING no es un socket abierto. Sin esto,
    // "conectando" seria un estado eterno y la pagina no sabria decir que no hay nadie.
    this.vigilantes.set(
      stack,
      setTimeout(() => {
        this.vigilantes.delete(stack);
        if (this.sockets.get(stack) !== socket) {
          return;
        }
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* se va a reintentar */
        }
        this.sockets.delete(stack);
        this.programarReintento(stack);
      }, ESPERA_APERTURA_MS),
    );

    socket.onopen = () => {
      this.cancelarVigilante(stack);
      this.update(stack, (estado) => ({ ...estado, state: 'abierto', intentos: 0 }));
    };

    socket.onmessage = (evento: MessageEvent<string>) => this.recibir(stack, String(evento.data));

    socket.onerror = () => this.update(stack, (estado) => ({ ...estado, state: 'reintentando' }));

    socket.onclose = () => {
      this.cancelarVigilante(stack);
      this.sockets.delete(stack);
      this.programarReintento(stack);
    };
  }

  private cancelarVigilante(stack: Stack): void {
    const vigilante = this.vigilantes.get(stack);
    if (vigilante) {
      clearTimeout(vigilante);
      this.vigilantes.delete(stack);
    }
  }

  /** Espera creciente: 1 s, 2 s, 4 s... con tope, para no martillear si el gateway esta caido. */
  private programarReintento(stack: Stack): void {
    if (this.parado || this.reintentos.has(stack)) {
      return;
    }
    const intento = (this.estados()[stack].intentos ?? 0) + 1;
    const espera = Math.min(1000 * 2 ** (intento - 1), 15000);
    this.update(stack, (estado) => ({ ...estado, state: 'reintentando', intentos: intento }));
    this.reintentos.set(
      stack,
      setTimeout(() => {
        this.reintentos.delete(stack);
        this.conectar(stack);
      }, espera),
    );
  }

  private recibir(stack: Stack, crudo: string): void {
    const frame = parseFrame(crudo);
    const ahora = Date.now();
    if (!frame) {
      // Un frame que no cuadra no puede tumbar la pagina: se apunta y se sigue.
      this.update(stack, (estado) => ({
        ...estado,
        badFrame: { raw: crudo.slice(0, 160), at: ahora },
      }));
      return;
    }
    switch (frame.kind) {
      case 'snapshot': {
        const { ticksIn, ticksOut } = frame.snapshot;
        this.update(stack, (estado) => ({
          ...estado,
          state: 'abierto',
          snapshot: frame.snapshot,
          window: [...estado.window, [ticksIn, ticksOut] as const].slice(-VENTANA),
          counters: contar(estado.counters, 'snapshot'),
          lastAt: ahora,
        }));
        break;
      }
      case 'position':
        this.update(stack, (estado) => ({
          ...estado,
          positions: [
            frame.position,
            ...estado.positions.filter(
              (otra) =>
                otra.account !== frame.position.account || otra.symbol !== frame.position.symbol,
            ),
          ].slice(0, MAX_POSICIONES),
          counters: contar(estado.counters, 'position'),
          lastAt: ahora,
        }));
        break;
      case 'alert':
        this.update(stack, (estado) => ({
          ...estado,
          alerts: [frame.alert, ...estado.alerts].slice(0, MAX_ALERTAS),
          counters: contar(estado.counters, 'alert'),
          lastAt: ahora,
        }));
        break;
    }
  }

  private update(stack: Stack, cambio: (estado: Live) => Live): void {
    this.estados.update((todos) => ({ ...todos, [stack]: cambio(todos[stack]) }));
  }
}

function contar(
  contadores: Readonly<Record<string, number>>,
  kind: string,
): Readonly<Record<string, number>> {
  return { ...contadores, [kind]: (contadores[kind] ?? 0) + 1 };
}
