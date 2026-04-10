import WebSocket from "ws";
import type {
  RelayProviderConfig,
  RelayIncomingEvent,
  RelayOutgoingEvent,
} from "./types.js";
import { relayLogger as logger } from "./logger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export type RelayEventCallback = (event: RelayIncomingEvent) => void;

export class RelayWsClient {
  private config: RelayProviderConfig;
  private onEvent: RelayEventCallback;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private wsFailLogged = false;
  private stopping = false;

  constructor(config: RelayProviderConfig, onEvent: RelayEventCallback) {
    this.config = config;
    this.onEvent = onEvent;
    this.reconnectDelay = config.relay.reconnect.initial;
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(event: RelayOutgoingEvent): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn("WS send failed: not connected");
      return false;
    }
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      logger.error("WS send error:", err);
      return false;
    }
  }

  // ── Private ──

  private connect(): void {
    if (this.stopping) return;

    const url = `${this.config.relay.ws_url}?api_key=${this.config.api_key}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this._connected = true;
      this.wsFailLogged = false;
      this.reconnectDelay = this.config.relay.reconnect.initial;
      logger.info("WebSocket connected");
      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as RelayIncomingEvent;
        this.onEvent(msg);
      } catch (err) {
        logger.error("WS message parse error:", err);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this._connected = false;
      this.stopHeartbeat();

      if (!this.wsFailLogged) {
        logger.warn(
          `WebSocket closed (code=${code}, reason=${reason.toString()})`
        );
        this.wsFailLogged = true;
      }

      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      if (!this.wsFailLogged) {
        logger.error("WebSocket error:", err.message);
        this.wsFailLogged = true;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;

    const delay = this.reconnectDelay;
    logger.info(`Reconnecting in ${delay}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay * 1000);
    this.reconnectTimer.unref();

    const { max, multiplier } = this.config.relay.reconnect;
    this.reconnectDelay = Math.min(delay * multiplier, max);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
