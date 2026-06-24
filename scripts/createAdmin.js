import bcrypt from 'bcryptjs';
import { connectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { Admin } from '../src/models/Admin.js';

const [, , email, password, name = 'Owner'] = process.argv;

if (!env.adminSeedSecret) {
  console.error('Set ADMIN_SEED_SECRET in .env before creating admin.');
  process.exit(1);
}

if (!email || !password) {
  console.error('Usage: npm run create-admin -- admin@example.com StrongPassword123 "Owner Name"');
  process.exit(1);
}

if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

await connectDb();
const passwordHash = await bcrypt.hash(password, 12);
const admin = await Admin.findOneAndUpdate(
  { email: email.toLowerCase().trim() },
  { name, email: email.toLowerCase().trim(), passwordHash, role: 'owner', isActive: true },
  { upsert: true, new: true }
);
console.log(`Admin ready: ${admin.email}`);
process.exit(0);
