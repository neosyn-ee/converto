#!/usr/bin/env node
// Compila il motore Swift solo su macOS; su Windows si usa il motore portabile (JavaScript).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform === 'darwin') {
  execFileSync('sh', [path.join(__dirname, 'build-engine.sh')], { stdio: 'inherit' });
}
