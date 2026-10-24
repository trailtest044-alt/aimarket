import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real supplier service with isolated configuration and fake HTTP.
const source = (await readFile(new URL('../src/services/plandawSupplier.js', import.meta.url), 'utf8'))
  .replace("import { env } from '../config/env.js';", 'const env = { plandawSupplier: { apiUrl: "https://supplier.test", apiKey: "test-only", timeoutMs: 3000 } };');
let instance = 0;
async function service() {
  return import('data:text/javascript;base64,' + Buffer.from(source + '\n// instance ' + instance++).toString('base64'));
}
test('supplier retry and catalog regressions', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  try {
    await t.test('an empty catalog remains authoritative during an outage', async () => {
      const api = await service();
      let now = 100000;
      Date.now = () => now;
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ products: [] }) });
      assert.equal((await api.plandawCatalogSnapshot()).authoritative, true);
      now += 31000;
      globalThis.fetch = async () => { throw new Error('offline'); };
      const snapshot = await api.plandawCatalogSnapshot();
      assert.equal(snapshot.authoritative, true);
      assert.deepEqual(snapshot.products, []);
    });
    Date.now = originalNow;
    await t.test('delivery can be fetched again after a local persistence failure', async () => {
      const api = await service();
      const delivery = { deliveryMode: 'manual', instruction: 'TEST ONLY' };
      let calls = 0;
      globalThis.fetch = async (url) => {
        calls++;
        assert.ok(url.endsWith('/orders/TEST-1/approve'));
        return { ok: true, json: async () => ({ delivery, alreadyDelivered: true }) };
      };
      const order = { orderId: 'TEST-1', supplier: { provider: 'plandaw', status: 'delivered' }, save: async () => {} };
      assert.deepEqual(await api.fetchPlandawDelivery(order), delivery);
      assert.equal(calls, 1);
    });
    await t.test('a retry discovers an order already fulfilled upstream', async () => {
      const api = await service();
      globalThis.fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/approve')
        ? { delivery: { deliveryMode: 'manual', instruction: 'TEST ONLY' } }
        : { order: { _id: 'partner-1', status: 'delivered' } } });
      const order = { orderId: 'TEST-2', supplier: { provider: 'plandaw', status: 'reservation_failed', productId: 'p1' }, save: async () => {} };
      assert.equal((await api.fetchPlandawDelivery(order)).instruction, 'TEST ONLY');
    });
    await t.test('missing delivery details never mark an order delivered', async () => {
      const api = await service();
      globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
      const order = { orderId: 'TEST-3', supplier: { provider: 'plandaw', status: 'stock_reserved' }, save: async () => {} };
      await assert.rejects(api.fetchPlandawDelivery(order), /missing details/);
      assert.equal(order.supplier.status, 'stock_reserved');
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
