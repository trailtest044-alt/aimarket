import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '' },
  shortDescription: { type: String, default: '' },
  category: { type: String, default: 'AI Tools' },
  imageUrl: { type: String, default: '' },
  badge: { type: String, default: '' },
  icon: { type: String, default: '✨' },
  priceBDT: { type: Number, required: true, min: 0 },
  pricePKR: { type: Number, required: true, min: 0 },
  priceUSDT: { type: Number, required: true, min: 0 },
  worldwideCurrency: { type: String, enum: ['USDT', 'USD'], default: 'USDT' },
  originalPriceBDT: { type: Number, default: 0, min: 0 },
  originalPricePKR: { type: Number, default: 0, min: 0 },
  originalPriceUSDT: { type: Number, default: 0, min: 0 },
  features: [{ type: String }],
  deliveryMethod: { type: String, default: 'Account login details will be delivered after admin approval.' },
  terms: { type: String, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByNickname: { type: String, default: '' },
  updatedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  updatedByNickname: { type: String, default: '' }
}, { timestamps: true });

productSchema.index({ isActive: 1, sortOrder: 1, createdAt: -1 });

export const Product = mongoose.model('Product', productSchema);
