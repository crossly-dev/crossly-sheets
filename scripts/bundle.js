'use strict';
// Packs the clasp project (manifest + src) into dist/crossly-sheets-<version>.zip.
// Uses the system `zip` (present on GitHub's ubuntu runners); no npm dependency.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = process.env.VERSION || require('../package.json').version;
const out = path.join(root, 'dist', `crossly-sheets-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-X', '-r', out, 'appsscript.json', 'src', '.claspignore', '.clasp.json.example', 'LICENSE', 'README.md', 'CHANGELOG.md'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(out);
