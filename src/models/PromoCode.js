import mongoose from 'mongoose';

const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  description: { type: String, default: '' },
  discountType: { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  percentOff: { type: Number, default: 0, min: 0, max: 100 },
  fixedBDT: { type: Number, default: 0, min: 0 },
  fixedPKR: { type: Number, default: 0, min: 0 },
  fixedUSDT: { type: Number, default: 0, min: 0 },
  maxUses: { type: Number, default: 0, min: 0 },
  usedCount: { type: Number, default: 0, min: 0 },
  minAmountBDT: { type: Number, default: 0, min: 0 },
  minAmountPKR: { type: Number, default: 0, min: 0 },
  minAmountUSDT: { type: Number, default: 0, min: 0 },
  productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  startsAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true, index: true },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByNickname: { type: String, default: '' },
  updatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  updatedByNickname: { type: String, default: '' }
}, { timestamps: true });

promoCodeSchema.index({ isActive: 1, code: 1 });

export const PromoCode = mongoose.model('PromoCode', promoCodeSchema);
