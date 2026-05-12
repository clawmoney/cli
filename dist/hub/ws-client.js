import WebSocket from "ws";
import { logger } from "./logger.js";
const HEARTBEAT_INTERVAL_MS = 30_000;
export class WsClient {
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
        this.reconnectDelay = config.provider.reconnect.initial;
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
        const url = `${this.config.provider.ws_url}?api_key=${this.config.api_key}`;
        this.ws = new WebSocket(url);
        this.ws.on("open", () => {
            this._connected = true;
            this.wsFailLogged = false;
            this.reconnectDelay = this.config.provider.reconnect.initial;
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
        this.reconnectTimer.unref();
        const { max, multiplier } = this.config.provider.reconnect;
        this.reconnectDelay = Math.min(delay * multiplier, max);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Application-level heartbeat. Backend's `event == "heartbeat"`
                // handler is what updates ClawAgent.last_heartbeat_at, which in
                // turn drives the `agent_is_online` field on /market/skills/search
                // results. A WS protocol-level ping/pong (this.ws.ping()) keeps
                // the TCP connection alive but the backend never sees it as a
                // JSON message — so DB heartbeat would only ever get bumped at
                // initial connect, then go stale after 600s and the agent would
                // disappear from search results despite the daemon being fine.
                try {
                    this.ws.send(JSON.stringify({ event: "heartbeat" }));
                }
                catch {
                    // Send failure is non-fatal; the reconnect loop will pick up
                    // a real socket close if the connection is actually dead.
                }
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
