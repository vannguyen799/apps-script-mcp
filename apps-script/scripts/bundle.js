'use strict';
// Builds apps-script/Code.gs: every src/*.js plus Admin.html inlined as ADMIN_HTML_, so users paste one file.
// Run: npm run bundle   (CI fails if the committed Code.gs is stale)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const order = ['Code.js', 'Auth.js', 'Actions.js', 'A1.js', 'Store.js'];
const found = fs.readdirSync(src).filter((n) => n.endsWith('.js')).sort();
const missing = found.filter((n) => !order.includes(n));
if (missing.length) throw new Error(`Add to the bundle order: ${missing.join(', ')}`);

const header = `/**
 * gsheets-mcp - Google Apps Script (single-file build)
 * https://github.com/vannguyen799/gsheets-mcp  (MIT)
 *
 * Paste this whole file into Code.gs of a new Apps Script project, then Deploy > New deployment > Web app:
 *   Execute as: Me    Who has access: Anyone
 * Generated from apps-script/src by scripts/bundle.js - do not edit by hand.
 */
`;
const parts = order.map((f) => `// ===== ${f} =====\n${fs.readFileSync(path.join(src, f), 'utf8').trimEnd()}\n`);
const html = fs.readFileSync(path.join(src, 'Admin.html'), 'utf8');
parts.push(`// ===== Admin.html =====\nvar ADMIN_HTML_ = ${JSON.stringify(html)};\n`);
fs.writeFileSync(path.join(root, 'Code.gs'), header + '\n' + parts.join('\n'));
console.log('wrote apps-script/Code.gs');
