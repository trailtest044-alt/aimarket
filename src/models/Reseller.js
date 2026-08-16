import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
  name: { type: String, default: '', trim: true },
  status: { type: String, enum: ['invited', 'active', 'suspended'], default: 'invited', index: true },
  creditLimitBDT: { type: Number, default: 0, min: 0 },
  internalNote: { type: String, default: '' },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByNickname: { type: String, default: '' }
}, { timestamps: true });
export const Reseller = mongoose.model('Reseller', schema);
