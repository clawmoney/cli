import WebSocket from "ws";
import type {
  HubFrame,
  ProviderFrame,
  TaskDaemonConfig,
} from "./types.js";

export type FrameCallback = (frame: HubFrame) => void;

/**
 * WebSocket client for the spareai-hub task protocol. Reconnects with
 * exponential backoff; emits heartbeats at the configured cadence so
 * the hub's KV skill_idx TTL stays fresh. Decoupled from the daemon's
 * skill-handling logic — frames in, frames out.
 */
export class TaskWsClient {
  private readonly config: TaskDaemonConfig;
  private readonly onFrame: FrameCallback;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopping = false;
  private _connected = false;

  constructor(config: TaskDaemonConfig, onFrame: FrameCallback) {
    this.config = config;
    this.onFrame = onFrame;
    this.reconnectDelayMs = config.reconnect?.initial_ms ?? 1000;
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

  send(frame: ProviderFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.stopping) return;

    const url = this.buildUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this._connected = true;
      this.reconnectDelayMs = this.config.reconnect?.initial_ms ?? 1000;
      console.log("[task] ws open");
      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      let frame: HubFrame;
      try {
        frame = JSON.parse(data.toString()) as HubFrame;
      } catch (err) {
        console.warn(`[task] ws non-json frame: ${data.toString().slice(0, 200)}`);
        return;
      }
      this.onFrame(frame);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this._connected = false;
      this.stopHeartbeat();
      console.warn(
        `[task] ws closed code=${code} reason="${reason.toString()}"`,
      );
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`[task] ws error: ${err.message}`);
    });
  }

  private buildUrl(): string {
    const u = new URL(this.config.hub_url);
    if (this.config.agent_id) {
      u.searchParams.set("agent_id", this.config.agent_id);
      u.searchParams.set("token", this.config.api_key || "devtoken");
    } else {
      u.searchParams.set("api_key", this.config.api_key);
    }
    if (this.config.agent_name) {
      u.searchParams.set("agent_name", this.config.agent_name);
    }
    u.searchParams.set("cli_type", "task-clawmoney");
    u.searchParams.set("skills", this.config.skills.join(","));
    u.searchParams.set(
      "concurrency",
      String(this.config.max_concurrency ?? 5),
    );
    // `models` is a relay-path field; harmless empty string here.
    u.searchParams.set("models", "");
    return u.toString();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    const delay = this.reconnectDelayMs;
    console.log(`[task] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // NOTE: do NOT .unref() here. The reconnect timer is the only
    // "live" handle the daemon has between WS close and the next
    // connect — if we unref it, and the WebSocket + heartbeat are
    // already torn down, Node's event loop sees nothing keeping it
    // alive and exits. Empirically this killed the mba daemon
    // after every 1006 disconnect.
    const { max_ms = 60_000, multiplier = 2 } = this.config.reconnect ?? {};
    this.reconnectDelayMs = Math.min(delay * multiplier, max_ms);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeat_ms ?? 5000;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ event: "heartbeat" }));
        } catch {
          /* the close handler will catch the real death */
        }
      }
    }, interval);
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
