import WebSocket from "ws";
import { relayLogger as logger } from "./logger.js";
const HEARTBEAT_INTERVAL_MS = 30_000;
export class RelayWsClient {
    config;
    onEvent;
    ws = null;
    heartbeatTimer = null;
    reconnectDelay;
    reconnectTimer = null;
    _connected = false;
    wsFailLogged = false;
    stopping = false;
    constructor(config, onEvent) {
        this.config = config;
        this.onEvent = onEvent;
        this.reconnectDelay = config.relay.reconnect.initial;
    }
    get connected() {
        return this._connected;
    }
    start() {
        this.stopping = false;
        this.connect();
    }
    stop() {
        this.stopping = true;
        this.clearTimers();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        this._connected = false;
    }
    send(event) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.warn("WS send failed: not connected");
            return false;
        }
        try {
            this.ws.send(JSON.stringify(event));
            return true;
        }
        catch (err) {
            logger.error("WS send error:", err);
            return false;
        }
    }
    // ── Private ──
    connect() {
        if (this.stopping)
            return;
        const url = `${this.config.relay.ws_url}?api_key=${this.config.api_key}`;
        this.ws = new WebSocket(url);
        this.ws.on("open", () => {
            this._connected = true;
            this.wsFailLogged = false;
            this.reconnectDelay = this.config.relay.reconnect.initial;
            logger.info("WebSocket connected");
            this.startHeartbeat();
        });
        this.ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.onEvent(msg);
            }
            catch (err) {
                logger.error("WS message parse error:", err);
            }
        });
        this.ws.on("close", (code, reason) => {
            this._connected = false;
            this.stopHeartbeat();
            if (!this.wsFailLogged) {
                logger.warn(`WebSocket closed (code=${code}, reason=${reason.toString()})`);
                this.wsFailLogged = true;
            }
            this.scheduleReconnect();
        });
        this.ws.on("error", (err) => {
            if (!this.wsFailLogged) {
                logger.error("WebSocket error:", err.message);
                this.wsFailLogged = true;
            }
        });
    }
    scheduleReconnect() {
        if (this.stopping)
            return;
        const delay = this.reconnectDelay;
        logger.info(`Reconnecting in ${delay}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay * 1000);
        // CRITICAL: do NOT .unref() this timer. When the WS handle closes we lose
        // our only refed I/O source — if the reconnect timer is unref'd Node sees
        // an empty event loop and the process silently exits with code 0 before
        // the timer fires. This was the "daemon dies after every Hub deploy" bug
        // observed in 0.12.0–0.12.2. Leaving the timer refed is what keeps the
        // daemon alive across WS disconnects.
        const { max, multiplier } = this.config.relay.reconnect;
        this.reconnectDelay = Math.min(delay * multiplier, max);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    clearTimers() {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
