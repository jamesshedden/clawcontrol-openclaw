import WebSocket from "ws"
import type { ClawControlConfig, InboundMessage, OutboundMessage, ThreadInfo } from "./types.js"

export class ClawControlConnection {
  private ws: WebSocket | null = null
  private config: ClawControlConfig
  private onMessage: (msg: InboundMessage) => void
  private onThreadList: ((threads: ThreadInfo[]) => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _connected = false
  private _threads: ThreadInfo[] = []

  constructor(config: ClawControlConfig, onMessage: (msg: InboundMessage) => void) {
    this.config = config
    this.onMessage = onMessage
  }

  isConnected(): boolean {
    return this._connected
  }

  /** Register a callback for thread list updates */
  setThreadListHandler(handler: (threads: ThreadInfo[]) => void): void {
    this.onThreadList = handler
  }

  /** Get the latest thread list */
  get threads(): ThreadInfo[] {
    return this._threads
  }

  /** Find a thread by its ID */
  getThread(threadId: string): ThreadInfo | undefined {
    return this._threads.find((t) => t.id === threadId)
  }

  /** Find a thread by file/folder path */
  getThreadByPath(relativePath: string): ThreadInfo | undefined {
    return this._threads.find((t) => t.path === relativePath)
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
        if (msg.type === "thread_list" && msg.threads) {
          this._threads = msg.threads
          console.log(`[clawcontrol] received thread_list: ${msg.threads.length} threads`)
          this.onThreadList?.(msg.threads)
        } else if (msg.type === "user_message" && msg.content) {
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

  sendText(content: string, id?: string, threadId?: string): void {
    this.send({ type: "agent_text", id, threadId, content })
  }

  sendTyping(id?: string, threadId?: string): void {
    this.send({ type: "agent_typing", id, threadId })
  }

  sendDone(id?: string, threadId?: string): void {
    this.send({ type: "agent_done", id, threadId })
  }

  sendError(error: string, id?: string, threadId?: string): void {
    this.send({ type: "error", id, threadId, error })
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
