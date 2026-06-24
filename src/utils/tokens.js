import crypto from 'crypto';
import { nanoid } from 'nanoid';

export function createOrderId() {
  return `ORD-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${nanoid(8).toUpperCase()}`;
}

export function createAccessToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
