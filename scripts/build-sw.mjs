import fs from 'node:fs'
import crypto from 'node:crypto'
const assets = fs.readdirSync('dist/assets').filter(name => /\.(js|mjs|css|wasm)$/.test(name)).map(name => `/assets/${name}`)
const shell = ['/', '/favicon.svg', '/models/manifest.json', '/stockfish/stockfish.js', ...assets]
const template = fs.readFileSync('scripts/sw-template.js', 'utf8')
const version = crypto.createHash('sha256').update(fs.readFileSync('dist/index.html'))
  .update(fs.readFileSync('dist/models/manifest.json')).update(fs.readFileSync('dist/stockfish/stockfish.js'))
  .update(template).update(JSON.stringify(shell)).digest('hex').slice(0, 16)
const source = template.replace('__BUILD__', version).replace('__SHELL__', JSON.stringify(shell))
fs.writeFileSync('dist/sw.js', source)
console.log(`Service worker ${version}: ${assets.length} assets`)
