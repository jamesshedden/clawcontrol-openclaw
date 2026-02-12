import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk"

import { clawcontrolPlugin } from "./src/channel.js"
import { setClawControlRuntime } from "./src/runtime.js"

const plugin = {
  id: "clawcontrol",
  name: "ClawControl",
  description: "ClawControl desktop app channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setClawControlRuntime(api.runtime)
    api.registerChannel({ plugin: clawcontrolPlugin })
  },
}

export default plugin
