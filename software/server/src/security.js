import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, digest] = encoded.split(':');
  return equal(scryptSync(password, salt, 32).toString('hex'), digest);
}
export class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.entries = new Map(); }
  accept(key, now = Date.now()) {
    let value = this.entries.get(key);
    if (this.entries.size > 4096) for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    // 有界存储：不允许攻击者用无限 key 消耗内存。
    if (!value && this.entries.size >= 8192) return false;
    if (!value || now >= value.until) { value = { count: 0, until: now + this.windowMs }; this.entries.set(key, value); }
    value.count++;
    return value.count <= this.max;
  }
}
