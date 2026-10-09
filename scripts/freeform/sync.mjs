// Copies freeform SVG skins into resources/themes and lists them in
// themes.json (after the classic themes). Metadata lives on the <svg> root:
//   data-za-id  data-za-name  data-za-description  data-za-panel
//
//   node scripts/freeform/sync.mjs   (also run by `npm run themes`)
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const themesDir = join(here, '../../resources/themes')
const manifestPath = join(themesDir, 'themes.json')

const attr = (svg, name) => svg.match(new RegExp(`<svg[^>]*\\s${name}="([^"]*)"`))?.[1]

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')).filter((t) => t.kind !== 'freeform')
for (const file of readdirSync(here).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = readFileSync(join(here, file), 'utf8')
  const id = attr(svg, 'data-za-id')
  if (!id) throw new Error(`${file}: missing data-za-id on <svg>`)
  copyFileSync(join(here, file), join(themesDir, `${id}.svg`))
  manifest.push({
    id,
    name: attr(svg, 'data-za-name') ?? id,
    description: attr(svg, 'data-za-description') ?? '',
    file: `${id}.svg`,
    kind: 'freeform',
    panel: attr(svg, 'data-za-panel'),
  })
  console.log(`${id}.svg  ${(svg.length / 1024).toFixed(0)} KB  (freeform)`)
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
