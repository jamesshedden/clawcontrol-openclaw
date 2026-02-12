import { clawcontrolPlugin } from "./src/channel.js"
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
  },
}

export default plugin
