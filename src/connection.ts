import WebSocket from "ws"
import type { ClawControlConfig, InboundMessage, OutboundMessage } from "./types.js"

export class ClawControlConnection {
  private ws: WebSocket | null = null
  private config: ClawControlConfig
  private onMessage: (msg: InboundMessage) => void
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _connected = false

  constructor(config: ClawControlConfig, onMessage: (msg: InboundMessage) => void) {
    this.config = config
    this.onMessage = onMessage
  }

  isConnected(): boolean {
    return this._connected
  }

  connect(): void {
    const wsUrl = this.buildWsUrl()
    console.log(`[clawcontrol] Connecting to ${wsUrl}`)

    this.ws = new WebSocket(wsUrl)

    this.ws.on("open", () => {
      console.log("[clawcontrol] WebSocket connected")
      this._connected = true
      this.send({ type: "connected" })
    })

    this.ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as InboundMessage
        if (msg.type === "user_message" && msg.content) {
          this.onMessage(msg)
        }
      } catch (err) {
        console.error("[clawcontrol] Failed to parse message:", err)
      }
    })

    this.ws.on("close", () => {
      console.log("[clawcontrol] WebSocket disconnected, reconnecting...")
      this._connected = false
      this.scheduleReconnect()
    })

    this.ws.on("error", (err: Error) => {
      console.error("[clawcontrol] WebSocket error:", err.message)
    })
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }

  send(msg: OutboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[clawcontrol] Cannot send — not connected")
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  get connected(): boolean {
    return this._connected
  }

  sendText(content: string, id?: string): void {
    this.send({ type: "agent_text", id, content })
  }

  sendTyping(id?: string): void {
    this.send({ type: "agent_typing", id })
  }

  sendDone(id?: string): void {
    this.send({ type: "agent_done", id })
  }

  sendError(error: string, id?: string): void {
    this.send({ type: "error", id, error })
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, 3000)
  }

  private buildWsUrl(): string {
    const base = this.config.url.replace(/\/$/, "")
    const protocol = base.startsWith("https") ? "wss" : "ws"
    const host = base.replace(/^https?:\/\//, "")
    return `${protocol}://${host}/ws?token=${encodeURIComponent(this.config.token)}`
  }
}
