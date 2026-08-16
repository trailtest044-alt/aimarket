import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  isVisible: { type: Boolean, default: true },
  priceBDT: { type: Number, default: null, min: 0 },
  pricePKR: { type: Number, default: null, min: 0 },
  priceUSDT: { type: Number, default: null, min: 0 },
  priceUSD: { type: Number, default: null, min: 0 },
  note: { type: String, default: '' },
  updatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  updatedByNickname: { type: String, default: '' }
}, { timestamps: true });
schema.index({ resellerId: 1, productId: 1 }, { unique: true });
export const ResellerProductAccess = mongoose.model('ResellerProductAccess', schema);
