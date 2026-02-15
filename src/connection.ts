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
  private _requestCounter = 0
  private _pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()

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
        const msg = JSON.parse(data.toString())
        // Handle response to a pending request
        if (msg.type === "response" && msg.requestId) {
          const pending = this._pendingRequests.get(msg.requestId)
          if (pending) {
            clearTimeout(pending.timer)
            this._pendingRequests.delete(msg.requestId)
            pending.resolve(msg)
          }
          return
        }
        if (msg.type === "thread_list" && msg.threads) {
          this._threads = msg.threads
          console.log(`[clawcontrol] received thread_list: ${msg.threads.length} threads`)
          this.onThreadList?.(msg.threads)
        } else if (msg.type === "user_message" && msg.content) {
          this.onMessage(msg as InboundMessage)
        }
      } catch (err) {
        console.error("[clawcontrol] Failed to parse message:", err)
      }
    })

    this.ws.on("close", (code: number, reason: Buffer) => {
      this._connected = false
      if (code === 4000) {
        // Replaced by a newer connection — don't reconnect, this instance is stale
        console.log("[clawcontrol] WebSocket closed (replaced by newer connection), not reconnecting")
        return
      }
      console.log(`[clawcontrol] WebSocket disconnected (code: ${code}, reason: ${reason.toString()}), reconnecting...`)
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

  sendPulse(content: string): void {
    this.send({ type: "pulse", content })
  }

  // ── Request-response: query the app for fresh data ──

  private sendRequest(type: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Not connected"))
      }
      const requestId = `req-${Date.now()}-${++this._requestCounter}`
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId)
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pendingRequests.set(requestId, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ type, requestId, ...params }))
    })
  }

  /** Request the full thread list from the app (always fresh) */
  async requestThreadList(): Promise<ThreadInfo[]> {
    const resp = await this.sendRequest("thread_list_request")
    if (resp.ok && resp.threads) {
      this._threads = resp.threads
      return resp.threads
    }
    throw new Error(resp.error || "Failed to get thread list")
  }

  /** Request info for a specific thread by ID */
  async requestThreadInfo(threadId: string): Promise<ThreadInfo & { title?: string }> {
    const resp = await this.sendRequest("thread_info_request", { threadId })
    if (resp.ok && resp.thread) {
      return resp.thread
    }
    throw new Error(resp.error || "Thread not found")
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
