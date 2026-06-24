import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Admin } from '../models/Admin.js';

export async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Admin token required' });

    const decoded = jwt.verify(token, env.jwtSecret);
    const admin = await Admin.findById(decoded.sub).select('-passwordHash');
    if (!admin || !admin.isActive) return res.status(401).json({ error: 'Invalid admin token' });

    req.admin = admin;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

export function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin._id.toString(), role: admin.role, email: admin.email },
    env.jwtSecret,
    { expiresIn: '8h' }
  );
}
