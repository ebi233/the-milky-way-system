/**
 * dsh-plugin-tavern — runtime glue plugin.
 *
 * Mounted host-side by cordis.patch.yml. On apply it materializes the
 * shipped assets into the harness home:
 *
 *   assets/presets/<id>/  ->  $DSH_HOME/.agent-presets/<id>/   (agent presets)
 *   assets/scripts/*.js   ->  $DSH_HOME/tavern/scripts/        (parser/polish/roleplay)
 *   assets/docs/SPEC.md   ->  $DSH_HOME/tavern/SPEC.md         (spec reference)
 *
 * Why materialize: the launcher pins the agent-presets roots to the shipped
 * preset directory on every boot, so plugin-declared roots are wiped; the
 * roster DOES scan the user preset root (includeUserRoot), so shipping the
 * presets there is the mechanism that works on every launcher.
 *
 * Materialization is marker-guarded: each preset directory gets a
 * `.dsh-plugin-tavern-version` marker, and the glue only writes a preset it
 * did not create before (fresh install) or whose marker version is older
 * (plugin upgrade). A directory without the marker is user-owned and is
 * never touched.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))
const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MARKER = '.dsh-plugin-tavern-version'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const PRESET_ROOT = path.join(DSH_HOME, '.agent-presets')
const TAVERN_DIR = path.join(DSH_HOME, 'tavern')
const SCRIPT_DIR = path.join(TAVERN_DIR, 'scripts')

let version = '0.0.0'
try {
  version = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version
} catch {
  // Keep the default when the manifest is unreadable.
}

function materializePresets() {
  const src = path.join(ASSETS, 'presets')
  if (!fs.existsSync(src)) return
  for (const id of fs.readdirSync(src)) {
    const dst = path.join(PRESET_ROOT, id)
    const markerFile = path.join(dst, MARKER)
    if (fs.existsSync(dst)) {
      if (fs.existsSync(markerFile)) {
        if (fs.readFileSync(markerFile, 'utf8') === version) continue // 同版本：不覆盖
        // 旧版本标记：升级覆盖
      } else {
        continue // 用户自有的预设：绝不覆盖
      }
    }
    fs.mkdirSync(dst, { recursive: true })
    fs.cpSync(path.join(src, id), dst, { recursive: true })
    fs.writeFileSync(markerFile, version)
    console.log(`[dsh-plugin-tavern] materialized preset ${id} -> ${dst}`)
  }
}

function materializeScripts() {
  const src = path.join(ASSETS, 'scripts')
  if (!fs.existsSync(src)) return
  fs.mkdirSync(SCRIPT_DIR, { recursive: true })
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(SCRIPT_DIR, f))
  }
  const specSrc = path.join(ASSETS, 'docs', 'SPEC.md')
  if (fs.existsSync(specSrc)) {
    fs.copyFileSync(specSrc, path.join(TAVERN_DIR, 'SPEC.md'))
  }
}

export const name = 'dsh-plugin-tavern'

export function apply(ctx) {
  ctx.effect(() => {
    try {
      materializePresets()
      materializeScripts()
    } catch (error) {
      console.error(`[dsh-plugin-tavern] materialization failed: ${error.message}`)
    }
  })
}
