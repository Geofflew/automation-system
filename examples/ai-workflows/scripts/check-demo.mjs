import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const [doc, output] = process.argv.slice(2)
const text = readFileSync(doc, 'utf8')
const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)]
assert.equal(blocks.length, 1, 'Expected one transcript block')
assert.equal(readFileSync(output, 'utf8').trim(), blocks[0][1].trim(), 'Demo differs from saved transcript')
console.log('Demo matches saved transcript')
