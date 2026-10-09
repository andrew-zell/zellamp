import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

const DEFAULTS: AppConfig = {
  alwaysOnTop: true,
  showInDock: true,
  onboarded: false,
  playerPos: {},
  zoom: 1,
  theme: 'graphite-pro',
  layout: null,
  doubled: false,
}

export function dataDir() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

const configPath = () => join(dataDir(), 'config.json')

export function loadConfig(): AppConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configPath(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

let pending: NodeJS.Timeout | null = null

/** Debounced atomic write; layout updates arrive on every drag frame. */
export function saveConfig(config: AppConfig) {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    const tmp = configPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2))
    renameSync(tmp, configPath())
  }, 300)
}
