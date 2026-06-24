import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '' },
  shortDescription: { type: String, default: '' },
  category: { type: String, default: 'AI Tools' },
  imageUrl: { type: String, default: '' },
  priceBDT: { type: Number, required: true, min: 0 },
  pricePKR: { type: Number, required: true, min: 0 },
  priceUSDT: { type: Number, required: true, min: 0 },
  features: [{ type: String }],
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

export const Product = mongoose.model('Product', productSchema);
