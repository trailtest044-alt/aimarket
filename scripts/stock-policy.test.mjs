import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldUseSupplierFallback,
  storefrontSellableStock,
  supplierReservationNeedsBackorder
} from '../src/services/stockPolicy.js';

test('linked display stock is capped by Plandaw real/backorder availability', () => {
  assert.equal(storefrontSellableStock({ actualStock: 0, backorderAvailable: 5, supplierStock: 0, supplierLinked: true }), 0);
  assert.equal(storefrontSellableStock({ actualStock: 0, backorderAvailable: 5, supplierStock: 3, supplierLinked: true }), 3);
  assert.equal(storefrontSellableStock({ actualStock: 0, backorderAvailable: 5, supplierStock: 9, supplierLinked: true }), 5);
});

test('Pakistan real stock stays sellable without Plandaw stock', () => {
  assert.equal(storefrontSellableStock({ actualStock: 2, backorderAvailable: 5, supplierStock: 0, supplierLinked: true }), 2);
  assert.equal(storefrontSellableStock({ actualStock: 2, backorderAvailable: 5, supplierStock: 0, supplierLinked: false }), 7);
});

test('Pakistan real stock is used before the Plandaw fallback', () => {
  assert.equal(shouldUseSupplierFallback({ actualStock: 1, orderIndex: 0, supplierProductId: 'plandaw-1' }), false);
  assert.equal(shouldUseSupplierFallback({ actualStock: 1, orderIndex: 1, supplierProductId: 'plandaw-1' }), true);
});

test('failed Plandaw reservation becomes a pending backorder', () => {
  assert.equal(supplierReservationNeedsBackorder({ reserved: false }), true);
  assert.equal(supplierReservationNeedsBackorder({ reserved: true }), false);
});
