import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Journal } from '../src/store.js';
import { jpegDimensions } from '../src/evidence.js';

test('exclusive journal writer and corruption fail closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new Journal(dir); journal.append('event', { source: 'simulator', id: 'a' });
  assert.throws(() => new Journal(dir), /locked/);
  journal.close();
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{not json}\n');
  assert.throws(() => new Journal(dir), /corruption/);
  assert.equal(fs.existsSync(path.join(dir, '.writer.lock')), false);
});

test('JPEG container rejects incomplete headers and dimensions bomb', () => {
  const image = fs.readFileSync(new URL('./fixtures/synthetic-green.jpg', import.meta.url));
  const missingEoi = image.subarray(0, image.length - 2);
  assert.throws(() => jpegDimensions(missingEoi), /invalid_jpeg/);
  const copy = Buffer.from(image);
  const sof = copy.indexOf(Buffer.from([0xff, 0xc0])); assert(sof > 0);
  copy.writeUInt16BE(65535, sof + 7);
  assert.throws(() => jpegDimensions(copy), /dimensions/);
});
