/**
 * Bridge — WebSocket server + client for Chrome Extension communication.
 * Auto-starts server if none running, waits for extension to connect.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
const DEFAULT_PORT = 18900;
const ACTION_TIMEOUT = 60000;
export class BridgeServer {
    wss = null;
    extensionClient = null;
    pendingRequests = new Map();
    extensionVersion = null;
    port;
    constructor(port) {
        this.port = port || DEFAULT_PORT;
    }
    start() {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
            this.wss.on('listening', () => resolve());
            this.wss.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this.port} already in use`));
                }
                else {
                    reject(error);
                }
            });
            this.wss.on('connection', (ws) => {
                ws.on('message', (data) => {
                    try {
                        this.handleMessage(ws, JSON.parse(data.toString()));
                    }
                    catch { /* ignore */ }
                });
                ws.on('close', () => {
                    if (this.extensionClient === ws) {
                        this.extensionClient = null;
                        this.extensionVersion = null;
                        for (const [id, pending] of this.pendingRequests) {
                            clearTimeout(pending.timer);
                            pending.reject(new Error('Extension disconnected'));
                            this.pendingRequests.delete(id);
                        }
                    }
                });
            });
        });
    }
    handleMessage(ws, message) {
        switch (message.type) {
            case 'status':
                if (this.extensionClient && this.extensionClient !== ws && this.extensionClient.readyState === WebSocket.OPEN) {
                    this.extensionClient.close(1000, 'Replaced');
                }
                this.extensionClient = ws;
                this.extensionVersion = message.version;
                break;
            case 'action': {
                if (!this.extensionClient || this.extensionClient.readyState !== WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'action_result', requestId: message.requestId, success: false, error: 'Extension not connected' }));
                    return;
                }
                const timer = setTimeout(() => {
                    this.pendingRequests.delete(message.requestId);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'action_result', requestId: message.requestId, success: false, error: 'Timeout' }));
                    }
                }, ACTION_TIMEOUT);
                this.pendingRequests.set(message.requestId, {
                    resolve: (result) => { if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify(result)); },
                    reject: (error) => { if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'action_result', requestId: message.requestId, success: false, error: error.message })); },
                    timer,
                });
                this.extensionClient.send(JSON.stringify(message));
                break;
            }
            case 'action_result': {
                const pending = this.pendingRequests.get(message.requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(message.requestId);
                    pending.resolve(message);
                }
                break;
            }
            case 'heartbeat':
                break;
        }
    }
    stop() {
        this.extensionClient?.close(1000, 'Shutdown');
        this.wss?.close();
        for (const [, p] of this.pendingRequests) {
            clearTimeout(p.timer);
            p.reject(new Error('Shutdown'));
        }
        this.pendingRequests.clear();
    }
    isExtensionConnected() {
        return this.extensionClient !== null && this.extensionClient.readyState === WebSocket.OPEN;
    }
    getExtensionVersion() { return this.extensionVersion; }
    getPort() { return this.port; }
}
// Singleton
let _server = null;
async function ensureBridge(port) {
    if (_server)
        return _server;
    const existing = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { ws.close(); resolve(false); }, 1000);
        ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true); });
        ws.on('error', () => { clearTimeout(t); resolve(false); });
    });
    if (existing)
        return null; // Use existing server as client
    const server = new BridgeServer(port);
    await server.start();
    _server = server;
    return server;
}
/**
 * Send an action to the Chrome Extension.
 * Auto-starts bridge if needed, waits for extension connection.
 */
export async function sendAction(actionType, params, port) {
    const wsPort = port || DEFAULT_PORT;
    const server = await ensureBridge(wsPort).catch(() => null);
    if (server && _server === server) {
        const start = Date.now();
        while (!server.isExtensionConnected() && Date.now() - start < 30000) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!server.isExtensionConnected()) {
            return { success: false, error: 'Chrome Extension not connected. Open Twitter in Chrome with BNBot extension enabled.' };
        }
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        const requestId = randomUUID();
        let settled = false;
        const timer = setTimeout(() => { if (!settled) {
            settled = true;
            ws.close();
            reject(new Error(`Timeout`));
        } }, ACTION_TIMEOUT);
        ws.on('open', () => { ws.send(JSON.stringify({ type: 'action', requestId, actionType, actionPayload: params })); });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'action_result' && msg.requestId === requestId) {
                    settled = true;
                    clearTimeout(timer);
                    ws.close();
                    resolve({ success: msg.success, data: msg.data, error: msg.error });
                }
            }
            catch { /* ignore */ }
        });
        ws.on('error', () => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('Cannot connect to bridge'));
        } });
        ws.on('close', () => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('Connection closed'));
        } });
    });
}
