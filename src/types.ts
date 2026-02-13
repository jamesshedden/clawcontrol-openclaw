export interface ClawControlConfig {
  url: string
  token: string
}

// Messages from the ClawControl app TO the plugin (user messages)
export interface InboundMessage {
  type: "user_message"
  id: string
  sessionId: string
  content: string
  noteContext?: string
}

// Messages from the plugin TO the ClawControl app (agent responses)
export interface OutboundMessage {
  type: "agent_text" | "agent_done" | "error" | "connected"
  id?: string
  content?: string
  error?: string
}
