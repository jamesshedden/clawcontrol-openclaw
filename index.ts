import { clawcontrolPlugin, getActiveConnection } from "./src/channel.js"
import { setClawControlRuntime } from "./src/runtime.js"

const plugin = {
  id: "clawcontrol",
  name: "ClawControl",
  description: "ClawControl desktop app channel plugin",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: any) {
    setClawControlRuntime(api.runtime)
    api.registerChannel({ plugin: clawcontrolPlugin })

    // ── Agent tools: query ClawControl thread data ──

    api.registerTool({
      name: "clawcontrol_threads",
      description:
        "Get the list of all file and folder threads from the ClawControl notes app. " +
        "Returns thread IDs (thr_*), type (file/folder), name, and relative path. " +
        "Use this to find the right thread ID before sending a message to a specific file or folder.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        const connection = getActiveConnection()
        if (!connection || !connection.connected) {
          return { content: [{ type: "text", text: "ClawControl is not connected." }] }
        }
        try {
          const threads = await connection.requestThreadList()
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(threads, null, 2),
              },
            ],
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }] }
        }
      },
    })

    api.registerTool({
      name: "clawcontrol_thread_info",
      description:
        "Get detailed info about a specific ClawControl thread by its ID. " +
        "Returns thread type, name, path, and title (for chat threads).",
      parameters: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "The thread ID (e.g. thr_a8f3c92d)",
          },
        },
        required: ["threadId"],
      },
      async execute(_id: string, params: { threadId: string }) {
        const connection = getActiveConnection()
        if (!connection || !connection.connected) {
          return { content: [{ type: "text", text: "ClawControl is not connected." }] }
        }
        try {
          const thread = await connection.requestThreadInfo(params.threadId)
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(thread, null, 2),
              },
            ],
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }] }
        }
      },
    })

    api.registerTool({
      name: "clawcontrol_send",
      description:
        "Send a proactive message to a specific thread in the ClawControl notes app. " +
        "Use clawcontrol_threads first to find the thread ID for the file or folder you want to message. " +
        "The message will appear in the chat panel for that file/folder, even if the user hasn't opened it yet.",
      parameters: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "The thread ID to send to (e.g. thr_a8f3c92d)",
          },
          message: {
            type: "string",
            description: "The message content to send",
          },
        },
        required: ["threadId", "message"],
      },
      async execute(_id: string, params: { threadId: string; message: string }) {
        const connection = getActiveConnection()
        if (!connection || !connection.connected) {
          return { content: [{ type: "text", text: "ClawControl is not connected." }] }
        }
        try {
          const msgId = `proactive-${Date.now()}`
          // Send typing indicator first
          connection.sendTyping(msgId, params.threadId)
          // Small delay to simulate natural typing
          await new Promise((resolve) => setTimeout(resolve, 500))
          // Send the message
          connection.sendText(params.message, msgId, params.threadId)
          // Mark done
          connection.sendDone(msgId, params.threadId)
          return {
            content: [
              {
                type: "text",
                text: `Message sent to thread ${params.threadId}`,
              },
            ],
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }] }
        }
      },
    })
  },
}

export default plugin
