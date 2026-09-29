'use strict';
// Builds apps-script/Code.gs: every src/*.js plus Admin.html inlined as ADMIN_HTML_, so users paste one file.
// Run: npm run bundle   (CI fails if the committed Code.gs is stale)
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
// Setup.js must come first, right after the header: the MCP server string-replaces its one line.
const order = ['Setup.js', 'Code.js', 'Auth.js', 'Actions.js', 'Eval.js', 'A1.js', 'Store.js'];
const found = fs.readdirSync(src).filter((n) => n.endsWith('.js')).sort();
const missing = found.filter((n) => !order.includes(n));
if (missing.length) throw new Error(`Add to the bundle order: ${missing.join(', ')}`);

const header = `/**
 * apps-script-mcp - Google Apps Script (single-file build)
 * https://github.com/vannguyen799/apps-script-mcp  (MIT)
 *
 * Paste this whole file into Code.gs of a new Apps Script project, then Deploy > New deployment > Web app:
 *   Execute as: Me    Who has access: Anyone
 * Generated from apps-script/src by scripts/bundle.js - do not edit by hand.
 */
`;
const parts = order.map((f) => `// ===== ${f} =====\n${fs.readFileSync(path.join(src, f), 'utf8').trimEnd()}\n`);
const html = fs.readFileSync(path.join(src, 'Admin.html'), 'utf8');
parts.push(`// ===== Admin.html =====\nvar ADMIN_HTML_ = ${JSON.stringify(html)};\n`);
const output = header + '\n' + parts.join('\n');
// The server replaces this exact line (DESIGN.md section 9.3): it must exist once, and only once, in the output.
const setupLine = 'var ASMCP_SETUP_ = null;';
const occurrences = output.split(setupLine).length - 1;
if (occurrences !== 1) throw new Error(`Expected "${setupLine}" exactly once in Code.gs, found ${occurrences}`);
if (!output.split('\n').includes(setupLine)) throw new Error(`"${setupLine}" must be on its own line`);
if (!output.startsWith(header + '\n// ===== Setup.js =====\n')) throw new Error('Setup.js must be first in the bundle');
fs.writeFileSync(path.join(root, 'Code.gs'), output);
console.log('wrote apps-script/Code.gs');
