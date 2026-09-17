/**
 * Servicio del WebSocket de eventos en vivo.
 *
 * Un socket por stack. Expone los datos como *signals* (nada de stores externos) y guarda una
 * **ventana movil corta**: llega un snapshot por segundo y la pagina solo necesita la forma reciente
 * para las graficas. El WebSocket es un fan-out sin reenvio: si un cliente se cae, pierde ese rato y
 * se corrige con el siguiente snapshot; por eso aqui no hay cola ni log, solo "el ultimo estado".
 *
 * Reconexion con espera creciente: si el gateway se cae, la pagina no se queda dando vueltas cada
 * milisegundo. 1s, 2s, 4s... hasta `reconnectMaxMs`, y se reinicia al primer mensaje bueno.
 */

import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import {
  AlertMessage,
  LiveMessage,
  ParseResult,
  PositionMessage,
  SnapshotMessage,
  Stack,
  StackEndpoints,
  STACKS,
} from '../core/contract';
import { parseLiveMessage } from '../core/contract.parser';
import { wsUrl } from '../core/urls';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Cuanto se espera a que un WebSocket abra (ms).
 *
 * Un socket que se queda en CONNECTING para siempre deja la UI en "connecting" sin decir nada. A
 * partir de aqui se corta, se apunta el motivo y se reintenta con espera creciente.
 */
export const SOCKET_OPEN_TIMEOUT_MS = 8000;

/** Un punto de la ventana movil: lo que hace falta para pintar, ya en numeros. */
export interface PulsePoint {
  /** Hora del servidor del snapshot, en milisegundos. */
  readonly t: number;
  /** Ticks consumidos de Kafka en ese segundo. */
  readonly ticksIn: number;
  /** Simbolos presentes en el snapshot (uno por simbolo). */
  readonly ticksOut: number;
}

/** Lo que la app sabe de un stack en vivo. */
export interface LiveState {
  readonly stack: Stack;
  readonly state: ConnectionState;
  readonly lastSnapshot: SnapshotMessage | null;
  readonly history: readonly PulsePoint[];
  readonly alerts: readonly AlertMessage[];
  readonly positions: readonly PositionMessage[];
  /** Mensajes parseados, por tipo. */
  readonly counters: Readonly<Record<string, number>>;
  /** Ultimo fallo de parseo, si lo hubo. */
  readonly lastParseError: { readonly reason: string; readonly raw: string; readonly at: number } | null;
  /** Intentos de reconexion acumulados. */
  readonly reconnects: number;
  /** Cuando llego el ultimo mensaje (ms epoch), para detectar un socket mudo. */
  readonly lastMessageAt: number | null;
}

const ESTADO_INICIAL = (stack: Stack): LiveState => ({
  stack,
  state: 'idle',
  lastSnapshot: null,
  history: [],
  alerts: [],
  positions: [],
  counters: {},
  lastParseError: null,
  reconnects: 0,
  lastMessageAt: null,
});

/** Cuantas alertas y posiciones se conservan para la lista de la UI. */
const MAX_ALERTAS = 50;
const MAX_POSICIONES = 100;

@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly endpoints: Readonly<Record<Stack, StackEndpoints>> = {
    spring: environment.spring,
    quarkus: environment.quarkus,
  };

  private readonly estados = signal<Readonly<Record<Stack, LiveState>>>({
    spring: ESTADO_INICIAL('spring'),
    quarkus: ESTADO_INICIAL('quarkus'),
  });

  /** Un socket por stack; `null` cuando esta cerrado. */
  private readonly sockets = new Map<Stack, WebSocket>();
  private readonly temporizadores = new Map<Stack, ReturnType<typeof setTimeout>>();
  private readonly intentos = new Map<Stack, number>();
  /** Vigilantes del handshake: si un socket no abre en `SOCKET_OPEN_TIMEOUT_MS`, se corta. */
  private readonly vigilantes = new Map<Stack, ReturnType<typeof setTimeout>>();
  private parado = false;

  constructor() {
    trazaArranque('LiveService: construido');
  }

  /** Estado en vivo de los dos stacks. */
  readonly live: Signal<Readonly<Record<Stack, LiveState>>> = this.estados.asReadonly();

  /** Total de mensajes parseados en los dos stacks. */
  readonly messageCount = computed(() =>
    STACKS.reduce((total, stack) => {
      const contadores = this.estados()[stack].counters;
      return total + Object.values(contadores).reduce((suma, valor) => suma + valor, 0);
    }, 0),
  );

  /** Hay al menos un socket abierto. */
  readonly connected = computed(() =>
    STACKS.some((stack) => this.estados()[stack].state === 'open'),
  );

  /** Abre los dos sockets. Idempotente. */
  start(): void {
    this.parado = false;
    for (const stack of STACKS) {
      this.conectar(stack);
    }
  }

  /** Cierra los sockets y cancela las reconexiones (al destruir la app o al parar en tests). */
  stop(): void {
    this.parado = true;
    for (const stack of STACKS) {
      const temporizador = this.temporizadores.get(stack);
      if (temporizador) {
        clearTimeout(temporizador);
        this.temporizadores.delete(stack);
      }
      this.cancelarVigilante(stack);
      const socket = this.sockets.get(stack);
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        try {
          socket.close();
        } catch {
          // Cerrar un socket ya cerrado no es un problema.
        }
        this.sockets.delete(stack);
      }
    }
  }

  /** Fuerza una reconexion inmediata de un stack (boton "reconnect"). */
  reconnectNow(stack: Stack): void {
    const temporizador = this.temporizadores.get(stack);
    if (temporizador) {
      clearTimeout(temporizador);
      this.temporizadores.delete(stack);
    }
    this.intentos.set(stack, 0);
    const socket = this.sockets.get(stack);
    if (socket) {
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Ignorado a proposito.
      }
      this.sockets.delete(stack);
    }
    this.conectar(stack);
  }

  private conectar(stack: Stack): void {
    if (this.parado || this.sockets.has(stack)) {
      return;
    }
    this.actualizar(stack, (estado) => ({
      ...estado,
      state: estado.lastSnapshot ? 'reconnecting' : 'connecting',
    }));

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl(this.endpoints[stack]));
    } catch {
      // URL invalida o WebSocket no disponible: se reintenta con espera creciente.
      this.programarReconexion(stack);
      return;
    }
    this.sockets.set(stack, socket);

    console.info('[aggora] socket creado', stack, wsUrl(this.endpoints[stack]));
    // Vigilante: un socket que se queda en CONNECTING no es un socket abierto. Si no abre a tiempo,
    // se corta y la reconexion con espera creciente se encarga. Asi `connecting` nunca es eterno.
    this.vigilantes.set(
      stack,
      setTimeout(() => {
        this.vigilantes.delete(stack);
        if (this.sockets.get(stack) !== socket) {
          return;
        }
        console.warn(
          `[aggora] el socket de ${stack} no abrio en ${SOCKET_OPEN_TIMEOUT_MS / 1000} s: se corta y se reintenta`,
        );
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Ignorado: ya se va a reintentar.
        }
        this.sockets.delete(stack);
        this.programarReconexion(stack);
      }, SOCKET_OPEN_TIMEOUT_MS),
    );

    socket.onopen = () => {
      console.info('[aggora] socket ABIERTO', stack);
      this.cancelarVigilante(stack);
      this.intentos.set(stack, 0);
      this.actualizar(stack, (estado) => ({ ...estado, state: 'open' }));
    };

    socket.onmessage = (evento: MessageEvent<string>) => {
      console.info('[aggora] mensaje recibido', stack, String(evento.data).slice(0, 60));
      this.recibir(stack, String(evento.data));
    };

    socket.onerror = () => {
      // `onerror` no trae detalle util; `onclose` viene detras y es quien reconecta.
      this.actualizar(stack, (estado) => ({ ...estado, state: 'reconnecting' }));
    };

    socket.onclose = () => {
      this.cancelarVigilante(stack);
      this.sockets.delete(stack);
      this.programarReconexion(stack);
    };
  }

  /** Cancela el vigilante del handshake de un stack. */
  private cancelarVigilante(stack: Stack): void {
    const vigilante = this.vigilantes.get(stack);
    if (vigilante) {
      clearTimeout(vigilante);
      this.vigilantes.delete(stack);
    }
  }

  /** Espera creciente: 1s, 2s, 4s, 8s... con tope. */
  private programarReconexion(stack: Stack): void {
    if (this.parado || this.temporizadores.has(stack)) {
      return;
    }
    const intento = (this.intentos.get(stack) ?? 0) + 1;
    this.intentos.set(stack, intento);
    const espera = Math.min(
      environment.reconnectMinMs * 2 ** (intento - 1),
      environment.reconnectMaxMs,
    );
    this.actualizar(stack, (estado) => ({
      ...estado,
      state: 'reconnecting',
      reconnects: estado.reconnects + 1,
    }));
    const temporizador = setTimeout(() => {
      this.temporizadores.delete(stack);
      this.conectar(stack);
    }, espera);
    this.temporizadores.set(stack, temporizador);
  }

  /** Procesa un frame: parseo defensivo y actualizacion de la ventana movil. */
  private recibir(stack: Stack, crudo: string): void {
    const resultado: ParseResult = parseLiveMessage(crudo);
    if (!resultado.ok) {
      this.actualizar(stack, (estado) => ({
        ...estado,
        lastParseError: { reason: resultado.reason, raw: resultado.raw, at: Date.now() },
      }));
      return;
    }
    const mensaje: LiveMessage = resultado.message;
    const ahora = Date.now();
    switch (mensaje.kind) {
      case 'snapshot': {
        const punto: PulsePoint = {
          t: Date.parse(mensaje.ts) || ahora,
          ticksIn: mensaje.ticksIn,
          ticksOut: mensaje.ticksOut,
        };
        this.actualizar(stack, (estado) => ({
          ...estado,
          state: 'open',
          lastSnapshot: mensaje,
          // Ventana movil corta: se corta la cabeza, no se guarda historia.
          history: [...estado.history, punto].slice(-environment.tickWindow),
          counters: contar(estado.counters, 'snapshot'),
          lastMessageAt: ahora,
        }));
        break;
      }
      case 'position':
        this.actualizar(stack, (estado) => ({
          ...estado,
          positions: [mensaje, ...estado.positions.filter((p) => p.account !== mensaje.account || p.symbol !== mensaje.symbol)].slice(
            0,
            MAX_POSICIONES,
          ),
          counters: contar(estado.counters, 'position'),
          lastMessageAt: ahora,
        }));
        break;
      case 'alert':
        this.actualizar(stack, (estado) => ({
          ...estado,
          alerts: [mensaje, ...estado.alerts].slice(0, MAX_ALERTAS),
          counters: contar(estado.counters, 'alert'),
          lastMessageAt: ahora,
        }));
        break;
    }
  }

  private actualizar(stack: Stack, cambio: (estado: LiveState) => LiveState): void {
    this.estados.update((todos) => ({ ...todos, [stack]: cambio(todos[stack]) }));
  }
}

function contar(
  contadores: Readonly<Record<string, number>>,
  kind: string,
): Readonly<Record<string, number>> {
  return { ...contadores, [kind]: (contadores[kind] ?? 0) + 1 };
}

/** Traza compartida de arranque, leible en `window.__aggoraTrace`. */
function trazaArranque(paso: string): void {
  const global = globalThis as { __aggoraTrace?: string[] };
  global.__aggoraTrace = global.__aggoraTrace ?? [];
  global.__aggoraTrace.push(`${Math.round(performance.now())} ms  ${paso}`);
}
