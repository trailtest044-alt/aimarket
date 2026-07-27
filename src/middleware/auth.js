import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Admin } from '../models/Admin.js';
import { Customer } from '../models/Customer.js';

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

export function requireOwner(req, res, next) {
  if (!req.admin || req.admin.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

export function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin._id.toString(), role: admin.role, email: admin.email, nickname: admin.nickname || admin.name, type: 'admin' },
    env.jwtSecret,
    { expiresIn: '8h' }
  );
}

export async function optionalCustomer(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();

    const decoded = jwt.verify(token, env.jwtSecret);
    if (decoded.type !== 'customer') return next();

    const customer = await Customer.findById(decoded.sub);
    if (customer?.isActive) req.customer = customer;
  } catch {
    // Public routes can still continue without a customer session.
  }
  next();
}

export async function requireCustomer(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Customer login required' });

    const decoded = jwt.verify(token, env.jwtSecret);
    if (decoded.type !== 'customer') return res.status(401).json({ error: 'Invalid customer token' });

    const customer = await Customer.findById(decoded.sub);
    if (!customer || !customer.isActive) return res.status(401).json({ error: 'Invalid customer token' });

    req.customer = customer;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired customer token' });
  }
}

export function signCustomerToken(customer) {
  return jwt.sign(
    { sub: customer._id.toString(), email: customer.email, type: 'customer' },
    env.jwtSecret,
    { expiresIn: '30d' }
  );
}
