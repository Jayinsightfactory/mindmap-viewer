'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { decide } = require('../src/work-file-uploader');
const { createApprovedPoll, locallyAvailable, resolveWorkRoot } = require('../src/work-drive-onedrive');

test('CI shorthand remains private outside the approved context', () => {
  assert.equal(decide({ filename: 'CI.pdf' }), 'no-signal');
  assert.equal(decide({ filename: 'CI.pdf', approvedOneDrive: true }), 'ok');
  assert.equal(decide({ filename: '개인 CI.pdf', approvedOneDrive: true }), 'personal');
  assert.equal(decide({ filename: 'CI.pdf.crdownload', approvedOneDrive: true }), 'ext');
});

test('approved OneDrive tracks new nested files across restart, postpones placeholders and retries failed writes', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-onedrive-check-'));
  t.after(async () => {
    assert.equal(path.dirname(temp), os.tmpdir());
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = await fs.realpath(temp);
  const root = path.join(base, 'Documents', 'Work');
  const nested = path.join(root, '2026', 'week');
  await fs.mkdir(nested, { recursive: true });
  assert.equal(await resolveWorkRoot(base, 'Documents/Work'), root);
  assert.equal(await resolveWorkRoot(base, 'Documents/../outside'), null);
  const external = path.join(base, 'outside');
  await fs.mkdir(external);
  const link = path.join(path.dirname(root), 'Link');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveWorkRoot(base, 'Documents/Link'), null);
  const stateFile = path.join(base, 'checkpoint.json');
  const data = '%PDF-1.7\n' + 'fixture'.repeat(200) + '\n%%EOF';
  const old = path.join(nested, '46-1 CI.pdf');
  await fs.writeFile(old, data);
  if (process.platform === 'win32') assert.equal(await locallyAvailable(old), true);
  let owner = 'assigned-owner', hydrated = false, accepts = false;
  let samples = [];
  const options = { root, stateFile, ownerId: 'assigned-owner', decide,
    getConfig: async () => ({ enabled: true, userId: owner, userName: 'Employee' }),
    ready: async () => hydrated, now: () => Date.now() + 10000,
    upload: async f => { samples.push(f.filename); return accepts; },
  };
  const first = createApprovedPoll(options);
  await first();
  assert.equal(samples.length, 0);
  const fresh = path.join(nested, 'CI.pdf');
  await fs.writeFile(fresh + '.crdownload', data);
  const restart = createApprovedPoll(options);
  await restart();
  assert.equal(samples.length, 0);
  await fs.rename(fresh + '.crdownload', fresh);
  await restart();
  assert.equal(samples.length, 0);
  hydrated = true;
  owner = 'previous-owner';
  await restart();
  assert.equal(samples.length, 0);
  owner = 'assigned-owner';
  await restart();
  accepts = true;
  await createApprovedPoll(options)();
  await createApprovedPoll(options)();
  assert.deepEqual(samples, ['CI.pdf', 'CI.pdf']);
  assert.equal((await fs.readFile(stateFile, 'utf8')).includes('CI.pdf'), false);
});
