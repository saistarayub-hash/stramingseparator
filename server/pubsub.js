// Tiny pub/sub for server->browser events over SSE. No external deps.
import { EventEmitter } from 'node:events';

export const hub = new EventEmitter();
hub.setMaxListeners(0);

/**
 * Broadcast a named event with payload to all SSE subscribers.
 */
export function emit(event, payload) {
  hub.emit(event, JSON.stringify(payload));
}
