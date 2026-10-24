import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../src/services/supplierSync.js', import.meta.url), 'utf8'))
  .replace(/^import .* from '(?!node:)[^']+';\r?\n/gm, '');
const { supplierImportFields } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('import identity is stable and separate packages never share a slug', () => {
  const data = { supplierProductId: 'p1', supplierPackageId: 'monthly', title: 'Test Product', pricePKR: 1000 };
  assert.deepEqual(supplierImportFields(data), supplierImportFields(data));
  assert.notEqual(supplierImportFields(data).slug, supplierImportFields({ ...data, supplierPackageId: 'yearly' }).slug);
  assert.equal(supplierImportFields(data).supplierProductId, 'p1');
  assert.equal(supplierImportFields(data).pricePKR, 1000);
  assert.throws(() => supplierImportFields({ ...data, pricePKR: 0 }), /Invalid/);
});
