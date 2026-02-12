import type { ClawControlConfig, InboundMessage } from "./types.js"
import { ClawControlConnection } from "./connection.js"
import { getClawControlRuntime } from "./runtime.js"

const DEFAULT_ACCOUNT_ID = "default"

export interface ClawControlAccount {
  accountId: string
  name: string
  enabled: boolean
  url: string
  token: string
  config: { url: string; token: string; enabled?: boolean }
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
    config: {
      url: String(source.url ?? ""),
      token: String(source.token ?? ""),
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
    sendText: async ({
      text,
      accountId,
      deps,
    }: {
      to: string
      text: string
      accountId?: string
      deps?: Record<string, unknown>
      replyToId?: string
      threadId?: string
    }) => {
      // This is the fallback sendText (used when no live connection is available).
      // In practice, responses go through the dispatch deliver callback below.
      const cfg = deps?.cfg as Record<string, unknown> | undefined
      if (!cfg) return { channel: "clawcontrol", ok: false, error: "no config" }
      console.log(`[clawcontrol] outbound.sendText fallback: ${text.slice(0, 80)}`)
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

      const connection = new ClawControlConnection(config, (data: InboundMessage) => {
        if (data.type === "user_message" && data.content) {
          log.info?.(
            `[${account.accountId}] inbound: ${data.content.slice(0, 80)}`,
          )
          dispatchToAgent({
            content: data.content,
            messageId: data.id,
            noteContext: data.noteContext,
            connection,
            config,
            cfg,
            log,
            accountId: account.accountId,
          })
        }
      })

      connection.connect()

      // Wait for abort signal to disconnect
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log.info?.(`[${account.accountId}] disconnecting`)
          connection.disconnect()
          resolve()
        })
      })
    },
  },
}

function dispatchToAgent({
  content,
  messageId,
  noteContext,
  connection,
  config,
  cfg,
  log,
  accountId,
}: {
  content: string
  messageId: string
  noteContext?: string
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
    connection.sendError("Agent dispatch not available", messageId)
    return
  }

  // If note context was provided, prepend it to the message
  const fullContent = noteContext
    ? `[Note context]\n${noteContext}\n\n[User message]\n${content}`
    : content

  const sessionKey = `clawcontrol:${accountId}`

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: fullContent,
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

  dispatch({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const text = payload.text ?? ""
        if (!text) return
        log.info?.(`[${accountId}] outbound: ${text.slice(0, 80)}`)
        connection.sendText(text, messageId)
      },
      onError: (err: unknown) => {
        log.error?.(`[${accountId}] dispatch error: ${String(err)}`)
        connection.sendError(String(err), messageId)
      },
    },
  }).catch((err: unknown) => {
    log.error?.(`[${accountId}] dispatch failed: ${String(err)}`)
    connection.sendError(String(err), messageId)
  })
}
