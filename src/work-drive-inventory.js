'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { decide } = require('./work-file-uploader');

// Inventory uses the same file gates as the uploader. Only hashes and extensions
// leave the device. A separate end record distinguishes partial runs.
async function inventory(report, roots = ['Desktop', 'Documents', 'Downloads'].map(name => path.join(os.homedir(), name))) {
  const summary = { files: 0, unreadable: 0, pages: 0 };
  let rows = [];
  async function flush() {
    if (!rows.length) return;
    await report({ page: summary.pages, rows });
    summary.pages++;
    rows = [];
  }
  async function walk(dir, level) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (err) { if (level || err.code !== 'ENOENT') summary.unreadable++; return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name.startsWith('~$') || /^(node_modules|AppData)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file, level + 1); continue; }
      if (!entry.isFile() || decide({ filename: entry.name }) !== 'ok') continue;
      let row;
      try {
        const st = await fs.stat(file);
        if (st.size < 1024 || st.size > 25 * 1024 * 1024) continue;
        const buf = await fs.readFile(file);
        const after = await fs.stat(file);
        if (st.mtimeMs !== after.mtimeMs || st.size !== buf.length) { summary.unreadable++; continue; }
        row = [crypto.createHash('sha256').update(buf).digest('hex'), path.extname(file).toLowerCase(), st.size, level];
      } catch { summary.unreadable++; continue; }
      rows.push(row);
      summary.files++;
      if (rows.length >= 100) await flush();
    }
  }
  for (const root of roots) await walk(root, 0);
  await flush();
  await report({ done: true, ...summary });
}
module.exports = { inventory };
