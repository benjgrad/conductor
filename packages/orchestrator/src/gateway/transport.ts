import type { OrchestratorToDaemon } from '@conductor/shared';
import { WebSocket } from 'ws';
import type { OutboxTransport, SendResult } from '../contracts.js';

/**
 * The live daemon sockets, by machine id (one socket per machine; a re-register replaces the
 * previous one). Also the gateway's `OutboxTransport` (T04 dispatcher → daemons): `send`
 * resolves `sent` once the frame is written, `not_connected` when the machine has no open
 * socket or the write fails.
 */
export class SocketTransport implements OutboxTransport {
  private readonly sockets = new Map<string, WebSocket>();

  bind(machineId: string, ws: WebSocket): WebSocket | undefined {
    const prev = this.sockets.get(machineId);
    this.sockets.set(machineId, ws);
    return prev === ws ? undefined : prev;
  }

  /** Unbind only if `ws` is still the machine's socket. Returns whether it was. */
  unbind(machineId: string, ws: WebSocket): boolean {
    if (this.sockets.get(machineId) !== ws) return false;
    this.sockets.delete(machineId);
    return true;
  }

  isConnected(machineId: string): boolean {
    return this.sockets.get(machineId)?.readyState === WebSocket.OPEN;
  }

  send(machineId: string, message: OrchestratorToDaemon): Promise<SendResult> {
    const ws = this.sockets.get(machineId);
    if (!ws) return Promise.resolve('not_connected');
    return sendFrame(ws, message);
  }
}

/** Write one message to a socket. */
export function sendFrame(ws: WebSocket, message: OrchestratorToDaemon): Promise<SendResult> {
  if (ws.readyState !== WebSocket.OPEN) return Promise.resolve('not_connected');
  return new Promise((resolve) => {
    ws.send(JSON.stringify(message), (err) => resolve(err ? 'not_connected' : 'sent'));
  });
}
