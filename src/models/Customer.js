import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  name: { type: String, default: '', trim: true },
  picture: { type: String, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  lastLoginAt: Date
}, { timestamps: true });

customerSchema.index({ email: 1, createdAt: -1 });

export const Customer = mongoose.model('Customer', customerSchema);
