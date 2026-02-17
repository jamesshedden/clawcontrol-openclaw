import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

// ── Messages sent to the server ──

interface FileSyncMessage {
  type: "file_sync"
  action: "upsert" | "delete"
  path: string
  content?: string
}

interface FileSnapshotMessage {
  type: "file_snapshot"
  files: Array<{ path: string; content: string }>
}

// ── Messages received from the server ──

export interface FileSyncPush {
  type: "file_sync_push"
  action: "upsert" | "delete" | "rename"
  path: string
  content?: string
  oldPath?: string
  version: number
}

export interface FileSnapshotAck {
  type: "file_snapshot_ack"
  updates: Array<{
    path: string
    content: string
    version: number
    action: "upsert" | "delete"
  }>
}

type SendFn = (msg: FileSyncMessage | FileSnapshotMessage) => void

interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export class FileSync {
  private notesPath: string
  private send: SendFn
  private log: Logger
  private watcher: fs.FSWatcher | null = null
  private suppressedPaths = new Map<string, number>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private static SUPPRESSION_WINDOW = 1000 // ms
  private static DEBOUNCE_DELAY = 300 // ms

  constructor(notesPath: string, send: SendFn, log: Logger) {
    this.notesPath = notesPath
    this.send = send
    this.log = log
  }

  /** Scan the notes directory, send a snapshot, and start watching for changes. */
  async start(): Promise<void> {
    const files = await this.scanDirectory()
    this.send({ type: "file_snapshot", files })
    this.log.info(`[sync] sent snapshot: ${files.length} files`)
    this.startWatcher()
  }

  /** Stop watching for changes. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.suppressedPaths.clear()
    this.log.info("[sync] stopped")
  }

  /** Handle a file change pushed from the server (client-originated). */
  async handleServerPush(msg: FileSyncPush): Promise<void> {
    const absPath = path.join(this.notesPath, msg.path)

    switch (msg.action) {
      case "upsert": {
        if (msg.content === undefined) return
        await this.ensureDir(path.dirname(absPath))
        this.suppress(msg.path)
        await fsp.writeFile(absPath, msg.content, "utf-8")
        this.log.info(`[sync] wrote: ${msg.path}`)
        break
      }
      case "delete": {
        this.suppress(msg.path)
        try {
          await fsp.unlink(absPath)
          this.log.info(`[sync] deleted: ${msg.path}`)
        } catch (err: any) {
          if (err.code !== "ENOENT") throw err
        }
        break
      }
      case "rename": {
        if (!msg.oldPath) return
        const oldAbs = path.join(this.notesPath, msg.oldPath)
        await this.ensureDir(path.dirname(absPath))
        this.suppress(msg.oldPath)
        this.suppress(msg.path)
        try {
          await fsp.rename(oldAbs, absPath)
          this.log.info(`[sync] renamed: ${msg.oldPath} -> ${msg.path}`)
        } catch (err: any) {
          if (err.code !== "ENOENT") throw err
        }
        break
      }
    }
  }

  /** Handle server-only files returned after our initial snapshot. */
  async handleSnapshotAck(msg: FileSnapshotAck): Promise<void> {
    for (const update of msg.updates) {
      if (update.action === "upsert") {
        const absPath = path.join(this.notesPath, update.path)
        await this.ensureDir(path.dirname(absPath))
        this.suppress(update.path)
        await fsp.writeFile(absPath, update.content, "utf-8")
        this.log.info(`[sync] wrote server-only file: ${update.path}`)
      }
    }
  }

  // ── Private ──

  private async scanDirectory(): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = []
    await this.walkDir(this.notesPath, "", files)
    return files
  }

  private async walkDir(
    dir: string,
    prefix: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue

      const fullPath = path.join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, relPath, files)
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = await fsp.readFile(fullPath, "utf-8")
          files.push({ path: relPath, content })
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(
        this.notesPath,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || filename.startsWith(".")) return
          if (!filename.endsWith(".md")) return

          const relPath = filename.replace(/\\/g, "/")

          if (this.isSuppressed(relPath)) return

          // Debounce rapid changes to the same file
          const existing = this.debounceTimers.get(relPath)
          if (existing) clearTimeout(existing)

          this.debounceTimers.set(
            relPath,
            setTimeout(() => {
              this.debounceTimers.delete(relPath)
              this.handleLocalChange(relPath)
            }, FileSync.DEBOUNCE_DELAY),
          )
        },
      )

      this.log.info(`[sync] watching: ${this.notesPath}`)
    } catch (err) {
      this.log.error(`[sync] failed to start watcher: ${err}`)
    }
  }

  private async handleLocalChange(relPath: string): Promise<void> {
    const absPath = path.join(this.notesPath, relPath)

    try {
      const stat = await fsp.stat(absPath)
      if (stat.isFile()) {
        const content = await fsp.readFile(absPath, "utf-8")
        this.send({ type: "file_sync", action: "upsert", path: relPath, content })
        this.log.info(`[sync] pushed change: ${relPath}`)
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.send({ type: "file_sync", action: "delete", path: relPath })
        this.log.info(`[sync] pushed delete: ${relPath}`)
      }
    }
  }

  private suppress(relPath: string): void {
    this.suppressedPaths.set(relPath, Date.now())
  }

  private isSuppressed(relPath: string): boolean {
    const suppressedAt = this.suppressedPaths.get(relPath)
    if (!suppressedAt) return false

    if (Date.now() - suppressedAt < FileSync.SUPPRESSION_WINDOW) {
      return true
    }

    this.suppressedPaths.delete(relPath)
    return false
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch {
      // ignore if already exists
    }
  }
}
