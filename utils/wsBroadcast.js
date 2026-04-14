'use strict';
/** Shared WebSocket broadcast store — avoids circular require between server.js and routes */

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const wsClients = new Map();

function addClient(userId, ws) {
  if (!wsClients.has(userId)) wsClients.set(userId, new Set());
  wsClients.get(userId).add(ws);
}

function removeClient(userId, ws) {
  wsClients.get(userId)?.delete(ws);
}

function broadcast(userId, payload) {
  const conns = wsClients.get(userId);
  if (!conns) return;
  const msg = JSON.stringify(payload);
  conns.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

module.exports = { addClient, removeClient, broadcast };
