const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inventory } = require('../src/work-drive-inventory');
(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drive-check-'));
  try {
    await mkdir(path.join(root, 'nested'));
    const bytes = Buffer.alloc(1200, 1);
    for (const name of ['order.pdf', '개인-order.pdf', 'nested/invoice 1.xlsx']) await writeFile(path.join(root, name), bytes);
    const pages = [];
    await inventory(async page => pages.push(page), [root]);
    assert.equal(pages[0].rows.length, 2);
    assert.equal(pages[0].rows[0][0], pages[0].rows[1][0]);
    assert.deepEqual(pages.at(-1), { done: true, files: 2, unreadable: 0, pages: 1 });
    assert.ok(!JSON.stringify(pages).includes('order'));
    await assert.rejects(inventory(async () => { throw Error('offline'); }, [root]), /offline/);
  } finally { await rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
