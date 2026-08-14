import { execFileSync } from 'node:child_process'

const npmCli = process.env.npm_execpath
if (npmCli === undefined) {
  throw new Error('verify:package must run through npm')
}

const output = execFileSync(process.execPath, [
  npmCli,
  'pack',
  '--dry-run',
  '--json',
  '--ignore-scripts',
], { encoding: 'utf8' })
const [pack] = JSON.parse(output)
if (pack === undefined || !Array.isArray(pack.files)) {
  throw new Error('npm pack did not return a file manifest')
}

const files = new Set(pack.files.map(file => file.path))
const required = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'INSTALL.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/invariant.js',
  'lib/invariant.d.ts',
]
const missing = required.filter(file => !files.has(file))
if (missing.length > 0) {
  throw new Error(`npm package is missing: ${missing.join(', ')}`)
}

const forbidden = [...files].filter(file => /^(?:\.github|examples|scripts|tests)(?:\/|$)/u.test(file))
if (forbidden.length > 0) {
  throw new Error(`npm package contains development files: ${forbidden.join(', ')}`)
}

console.log(`verified npm package manifest (${files.size} files)`)
