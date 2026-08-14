import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('standalone package boundary', () => {
  it('ships an auto-mounting host patch without preset artifacts', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      license: string
      files: string[]
      scripts: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')

    expect(root).toMatch(/[\\/]progressive-tools[\\/]?$/u)
    expect(manifest.name).toBe('dsh-progressive-tools')
    expect(manifest.license).toBe('Apache-2.0')
    expect(manifest.files).toContain('LICENSE')
    expect(manifest.files).not.toContain('examples')
    expect(manifest.scripts.check).not.toContain('pnpm run')
    expect(manifest.scripts.prepublishOnly).toBe('npm run check')
    expect(license).toContain('Apache License\nVersion 2.0, January 2004')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toContain('id: progressive-tools')
    expect(patch).toContain('name: dsh-progressive-tools')
    expect(source).not.toContain('deepseek-harness')
    expect(source).not.toContain('invoke_tool')
  })
})
