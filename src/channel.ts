import type { ClawControlConfig, InboundMessage } from "./types.js"
import { ClawControlConnection } from "./connection.js"
import { FileSync } from "./sync.js"
import { getClawControlRuntime } from "./runtime.js"

const DEFAULT_ACCOUNT_ID = "default"

// Track active connections per account so tools and handleAction can use them
const activeConnections = new Map<string, ClawControlConnection>()

// Track active sessions so outbound.sendText can route to the right thread
const activeSessions = new Map<string, { connection: ClawControlConnection; threadId?: string }>()

/** Get the first active connection (for use by agent tools) */
export function getActiveConnection(): ClawControlConnection | undefined {
  for (const [, conn] of activeConnections) {
    if (conn.connected) return conn
  }
  return undefined
}

export interface ClawControlAccount {
  accountId: string
  name: string
  enabled: boolean
  url: string
  token: string
  notesPath: string
  config: { url: string; token: string; notesPath?: string; enabled?: boolean }
}

export interface GatewayContext {
  cfg: Record<string, unknown>
  accountId: string
  account: ClawControlAccount
  runtime: Record<string, any>
  abortSignal: AbortSignal
  log: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
    debug: (msg: string) => void
  }
  getStatus: () => Record<string, unknown>
  setStatus: (next: Record<string, unknown>) => void
}

function getChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = cfg.channels as Record<string, unknown> | undefined
  return (channels?.clawcontrol as Record<string, unknown>) ?? {}
}

function resolveAccount(cfg: Record<string, unknown>, accountId: string): ClawControlAccount {
  const channelCfg = getChannelConfig(cfg)

  let source: Record<string, unknown>
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const accounts = (channelCfg.accounts ?? {}) as Record<string, unknown>
    source = (accounts[accountId] ?? {}) as Record<string, unknown>
  } else {
    source = channelCfg
  }

  return {
    accountId,
    name: accountId === DEFAULT_ACCOUNT_ID ? "ClawControl" : `ClawControl (${accountId})`,
    enabled: source.enabled !== false,
    url: String(source.url ?? ""),
    token: String(source.token ?? ""),
    notesPath: String(source.notesPath ?? ""),
    config: {
      url: String(source.url ?? ""),
      token: String(source.token ?? ""),
      notesPath: source.notesPath ? String(source.notesPath) : undefined,
      enabled: source.enabled !== false,
    },
  }
}

export const clawcontrolPlugin = {
  id: "clawcontrol",

  meta: {
    id: "clawcontrol",
    label: "ClawControl",
    selectionLabel: "ClawControl (Desktop App)",
    detailLabel: "ClawControl Desktop",
    blurb: "Desktop notes app with AI chat via WebSocket.",
    order: 100,
  },

  capabilities: {
    chatTypes: ["direct"],
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => {
      const channelCfg = getChannelConfig(cfg)
      const accounts = (channelCfg.accounts ?? {}) as Record<string, unknown>
      return [DEFAULT_ACCOUNT_ID, ...Object.keys(accounts)]
    },
    resolveAccount: (cfg: Record<string, unknown>, accountId: string) =>
      resolveAccount(cfg, accountId),
    defaultAccountId: (_cfg: Record<string, unknown>) => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: ClawControlAccount) =>
      Boolean(account.url?.trim() && account.token?.trim()),
    isEnabled: (account: ClawControlAccount) => account.enabled !== false,
    describeAccount: (account: ClawControlAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url?.trim() && account.token?.trim()),
    }),
    setAccountEnabled: ({
      cfg,
      accountId,
      enabled,
    }: {
      cfg: Record<string, unknown>
      accountId: string
      enabled: boolean
    }) => {
      const channels = (cfg.channels ?? {}) as Record<string, unknown>
      const cc = (channels.clawcontrol ?? {}) as Record<string, unknown>
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        const accounts = (cc.accounts ?? {}) as Record<string, unknown>
        const acct = (accounts[accountId] ?? {}) as Record<string, unknown>
        return {
          ...cfg,
          channels: {
            ...channels,
            clawcontrol: {
              ...cc,
              accounts: { ...accounts, [accountId]: { ...acct, enabled } },
            },
          },
        }
      }
      return { ...cfg, channels: { ...channels, clawcontrol: { ...cc, enabled } } }
    },
    deleteAccount: ({
      cfg,
      accountId,
    }: {
      cfg: Record<string, unknown>
      accountId: string
    }) => {
      const channels = { ...(cfg.channels as Record<string, unknown>) }
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        const cc = { ...(channels.clawcontrol as Record<string, unknown>) }
        const accounts = { ...(cc.accounts as Record<string, unknown>) }
        delete accounts[accountId]
        cc.accounts = accounts
        channels.clawcontrol = cc
        return { ...cfg, channels }
      }
      delete channels.clawcontrol
      return { ...cfg, channels }
    },
    resolveAllowFrom: () => [] as string[],
    formatAllowFrom: ({ allowFrom }: { allowFrom: string[] }) => allowFrom,
  },

  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) => {
      if (text.length <= limit) return [text]
      const chunks: string[] = []
      for (let i = 0; i < text.length; i += limit) {
        chunks.push(text.slice(i, i + limit))
      }
      return chunks
    },
    chunkerMode: "text",
    textChunkLimit: 8000,
    resolveTarget: ({ to }: { to?: string }) => {
      // Accept any target — we route based on active sessions
      return { ok: true as const, to: to || "user" }
    },
    sendText: async ({
      text,
      accountId: acctId,
    }: {
      to: string
      text: string
      accountId?: string
      deps?: Record<string, unknown>
      replyToId?: string
      threadId?: string
    }) => {
      const connId = acctId || DEFAULT_ACCOUNT_ID
      const connection = activeConnections.get(connId)
      if (!connection || !connection.connected) {
        return { channel: "clawcontrol", ok: false, error: "Not connected" }
      }

      // Find the most recent session for this account to get the threadId
      let targetThread: string | undefined
      for (const [key, session] of activeSessions) {
        if (key.startsWith(`clawcontrol:${connId}:`) && session.connection === connection) {
          targetThread = session.threadId
        }
      }

      const msgId = `outbound-${Date.now()}`
      connection.sendText(text, msgId, targetThread)
      connection.sendDone(msgId, targetThread)

      return { channel: "clawcontrol", ok: true }
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }: { account: ClawControlAccount; timeoutMs?: number }) => {
      if (!account.url || !account.token) return { ok: false, error: "not configured" }
      try {
        const res = await fetch(`${account.url.replace(/\/$/, "")}/health`)
        return { ok: res.ok, status: res.status }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
    buildAccountSnapshot: ({
      account,
      runtime,
    }: {
      account: ClawControlAccount
      cfg: Record<string, unknown>
      runtime?: Record<string, unknown>
      probe?: Record<string, unknown>
      audit?: Record<string, unknown>
    }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url?.trim() && account.token?.trim()),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx: GatewayContext) => {
      const { account, abortSignal, log, cfg } = ctx
      const config: ClawControlConfig = { url: account.url, token: account.token }

      log.info?.(`[${account.accountId}] connecting to ${account.url}`)

      let fileSync: FileSync | null = null

      const connection = new ClawControlConnection(config, (data: InboundMessage) => {
        if (data.type === "user_message" && data.content) {
          log.info?.(
            `[${account.accountId}] inbound: ${data.content.slice(0, 80)} (threadId: ${data.threadId})`,
          )
          dispatchToAgent({
            content: data.content,
            messageId: data.id!,
            sessionId: data.sessionId!,
            threadId: data.threadId,
            noteContext: data.noteContext,
            history: data.history,
            connection,
            config,
            cfg,
            log,
            accountId: account.accountId,
          })
        }
      })

      // Set up file sync if notesPath is configured
      if (account.notesPath) {
        fileSync = new FileSync(
          account.notesPath,
          (msg) => connection.send(msg as any),
          log,
        )

        connection.setFileSyncHandlers(
          (msg) => fileSync!.handleServerPush(msg).catch((err) =>
            log.error?.(`[${account.accountId}] file sync push error: ${err}`),
          ),
          (msg) => fileSync!.handleSnapshotAck(msg).catch((err) =>
            log.error?.(`[${account.accountId}] file snapshot ack error: ${err}`),
          ),
        )
      }

      connection.connect()
      activeConnections.set(account.accountId, connection)

      // Start file sync after connection is established
      if (fileSync) {
        // Wait a tick for the WebSocket to connect before sending the snapshot
        const startSync = () => {
          if (connection.connected) {
            fileSync!.start().catch((err) =>
              log.error?.(`[${account.accountId}] file sync start error: ${err}`),
            )
          } else {
            setTimeout(startSync, 500)
          }
        }
        setTimeout(startSync, 1000)
      }

      // Wait for abort signal to disconnect
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log.info?.(`[${account.accountId}] disconnecting`)
          fileSync?.stop()
          activeConnections.delete(account.accountId)
          connection.disconnect()
          resolve()
        })
      })
    },
  },

  actions: {
    listActions: () => ["thread-list", "thread-info"],

    handleAction: async ({
      action,
      params,
      accountId,
    }: {
      action: string
      params?: Record<string, unknown>
      accountId?: string
    }) => {
      // Look up by accountId first, fall back to any active connection
      const connId = accountId || DEFAULT_ACCOUNT_ID
      let connection = activeConnections.get(connId)
      if (!connection || !connection.connected) {
        // Fall back to first available connection (typically only one)
        for (const [, conn] of activeConnections) {
          if (conn.connected) {
            connection = conn
            break
          }
        }
      }
      if (!connection || !connection.connected) {
        return { ok: false, error: "ClawControl not connected" }
      }

      switch (action) {
        case "thread-list": {
          try {
            const threads = await connection.requestThreadList()
            return { ok: true, threads }
          } catch (err) {
            return { ok: false, error: String(err) }
          }
        }
        case "thread-info": {
          const threadId = params?.threadId as string
          if (!threadId) {
            return { ok: false, error: "threadId parameter required" }
          }
          try {
            const thread = await connection.requestThreadInfo(threadId)
            return { ok: true, thread }
          } catch (err) {
            return { ok: false, error: String(err) }
          }
        }
        default:
          return { ok: false, error: `Unknown action: ${action}` }
      }
    },
  },
}

function dispatchToAgent({
  content,
  messageId,
  sessionId,
  threadId,
  noteContext,
  history,
  connection,
  config,
  cfg,
  log,
  accountId,
}: {
  content: string
  messageId: string
  sessionId: string
  threadId?: string
  noteContext?: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  connection: ClawControlConnection
  config: ClawControlConfig
  cfg: Record<string, unknown>
  log: GatewayContext["log"]
  accountId: string
}) {
  const runtime = getClawControlRuntime()
  const dispatch = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher

  if (!dispatch) {
    log.warn?.(
      `[${accountId}] runtime dispatch not available — message logged but not processed`,
    )
    connection.sendError("Agent dispatch not available", messageId, threadId)
    return
  }

  // If note context was provided, prepend it to the message
  const fullContent = noteContext
    ? `[Note context]\n${noteContext}\n\n[User message]\n${content}`
    : content

  // Build structured conversation history for the framework
  const inboundHistory = history?.map((m) => ({
    sender: m.role === "user" ? "user" : "agent",
    body: m.content,
    timestamp: Date.now(),
  }))

  // Use threadId for the session key if available, falling back to sessionId
  const sessionKey = `clawcontrol:${accountId}:${threadId || sessionId}`

  // Track session so outbound.sendText can route to the right thread
  activeSessions.set(sessionKey, { connection, threadId })

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: fullContent,
    BodyForAgent: content,
    InboundHistory: inboundHistory,
    From: "clawcontrol:user",
    To: `clawcontrol:${accountId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct",
    Provider: "clawcontrol",
    Surface: "clawcontrol",
    MessageSid: `clawcontrol-${Date.now()}`,
    CommandAuthorized: true,
    OriginatingChannel: "clawcontrol",
    OriginatingTo: `clawcontrol:${accountId}`,
  })

  let chunkIndex = 0

  dispatch({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }, info?: { kind?: string }) => {
        const text = payload.text ?? ""
        if (!text) return
        const chunkId = `${messageId}-${chunkIndex}`
        chunkIndex++
        log.info?.(`[${accountId}] outbound ${info?.kind ?? "chunk"} ${chunkIndex}: ${text.slice(0, 80)}`)
        connection.sendText(text, chunkId, threadId)
      },
      onReplyStart: () => {
        connection.sendTyping(messageId, threadId)
      },
      onError: (err: unknown) => {
        log.error?.(`[${accountId}] dispatch error: ${String(err)}`)
        connection.sendError(String(err), messageId, threadId)
      },
    },
    replyOptions: {},
  }).then(() => {
    log.info?.(`[${accountId}] dispatch complete`)
    connection.sendDone(messageId, threadId)
  }).catch((err: unknown) => {
    log.error?.(`[${accountId}] dispatch failed: ${String(err)}`)
    connection.sendError(String(err), messageId, threadId)
  })
}
