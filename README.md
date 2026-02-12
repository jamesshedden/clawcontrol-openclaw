# clawcontrol-openclaw

OpenClaw channel plugin for [ClawControl](https://github.com/jamesshedden/clawcontrol) — a desktop notes app with AI chat.

The plugin connects your OpenClaw agent to the ClawControl desktop app over WebSocket. ClawControl runs a server; the plugin connects outbound to it (same pattern as the Discord channel).

## Install

```bash
git clone https://github.com/jamesshedden/clawcontrol-openclaw.git ~/.openclaw/extensions/clawcontrol
```

## Configure

Set the URL and token to match your ClawControl app's settings:

```bash
openclaw config set channels.clawcontrol.enabled true
openclaw config set channels.clawcontrol.url "http://<clawcontrol-host>:3777"
openclaw config set channels.clawcontrol.token "<shared-token>"
openclaw gateway restart
```

- **url** — the address where your ClawControl desktop app is running (e.g. `http://192.168.1.50:3777`, a Tailscale IP, or an ngrok URL)
- **token** — a shared secret, must match the token set in ClawControl's Settings

## Verify

```bash
openclaw logs
```

You should see `[clawcontrol] Connected` once the plugin reaches the ClawControl server.

## How it works

```
ClawControl (your machine)          OpenClaw (remote machine)
┌──────────────────┐                ┌──────────────────┐
│  Desktop App     │                │  Gateway         │
│  ┌────────────┐  │                │  ┌────────────┐  │
│  │ WS Server  │◄─┼── outbound ───┤  │ This plugin│  │
│  │ :3777      │  │   connection   │  └────────────┘  │
│  └────────────┘  │                └──────────────────┘
└──────────────────┘
```

The plugin registers `clawcontrol` as a messaging channel. When your OpenClaw agent sends a response, the plugin delivers it over the WebSocket to your desktop app. When you type a message in the app, it flows back through the plugin to the agent.

## License

MIT
