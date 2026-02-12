// Holds reference to the OpenClaw runtime, set during plugin registration.
// The runtime provides access to channel dispatch helpers.

let _runtime: Record<string, any> | null = null

export function setClawControlRuntime(runtime: Record<string, any>): void {
  _runtime = runtime
}

export function getClawControlRuntime(): Record<string, any> {
  if (!_runtime) throw new Error("ClawControl runtime not initialized")
  return _runtime
}
