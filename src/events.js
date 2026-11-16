import { EventEmitter } from 'node:events';
import { db } from './db.js';

export const bus = new EventEmitter();
bus.setMaxListeners(200);
export const emit = (type, data = {}) => bus.emit('event', { type, ...data });

export const incCode = (id) => `INC-${String(id).padStart(5, '0')}`;
export function addEvent(incidentId, type, message, userId = null) {
  db.run('INSERT INTO incident_events(incident_id,ts,type,message,user_id) VALUES(?,?,?,?,?)', incidentId, Date.now(), type, message, userId);
}
export const SEV_RANK = { informational: 0, low: 1, medium: 2, high: 3, critical: 4 };
