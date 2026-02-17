export interface ClawControlConfig {
  url: string
  token: string
}

// Thread metadata sent from the app
export interface ThreadInfo {
  id: string
  type: "file" | "folder"
  name: string
  path: string
}

// Messages from the ClawControl app TO the plugin
export interface InboundMessage {
  type: "user_message" | "thread_list"
  id?: string
  sessionId?: string
  /** Thread ID from the registry — stable across renames */
  threadId?: string
  content?: string
  noteContext?: string
  /** Thread list (when type is "thread_list") */
  threads?: ThreadInfo[]
}

// Messages from the plugin TO the ClawControl server (agent responses + requests + file sync)
export interface OutboundMessage {
  type: "agent_text" | "agent_done" | "agent_typing" | "error" | "connected"
    | "thread_list_request" | "thread_info_request" | "pulse"
    | "file_sync" | "file_snapshot"
  id?: string
  /** Thread ID — used to target a specific thread (required for proactive messages) */
  threadId?: string
  content?: string
  error?: string
  /** Request ID for request-response protocol */
  requestId?: string
  /** file_sync fields */
  action?: "upsert" | "delete"
  path?: string
  /** file_snapshot fields */
  files?: Array<{ path: string; content: string }>
}
