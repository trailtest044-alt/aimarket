import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'admin', 'support'], default: 'admin' },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date
}, { timestamps: true });

export const Admin = mongoose.model('Admin', adminSchema);
