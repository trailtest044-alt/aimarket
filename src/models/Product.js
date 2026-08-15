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
  isFree: { type: Boolean, default: false },
  worldwideCurrency: { type: String, enum: ['USDT', 'USD'], default: 'USDT' },
  originalPriceBDT: { type: Number, default: 0, min: 0 },
  originalPricePKR: { type: Number, default: 0, min: 0 },
  originalPriceUSDT: { type: Number, default: 0, min: 0 },
  purchaseCostBDT: { type: Number, default: 0, min: 0 },
  purchaseCostPKR: { type: Number, default: 0, min: 0 },
  purchaseCostUSDT: { type: Number, default: 0, min: 0 },
  accountCostBDT: { type: Number, default: 0, min: 0 },
  accountCostPKR: { type: Number, default: 0, min: 0 },
  accountCostUSDT: { type: Number, default: 0, min: 0 },
  paymentGatewayFeeBDT: { type: Number, default: 0, min: 0 },
  paymentGatewayFeePKR: { type: Number, default: 0, min: 0 },
  paymentGatewayFeeUSDT: { type: Number, default: 0, min: 0 },
  otherExpenseBDT: { type: Number, default: 0, min: 0 },
  otherExpensePKR: { type: Number, default: 0, min: 0 },
  otherExpenseUSDT: { type: Number, default: 0, min: 0 },
  features: [{ type: String }],
  deliveryMethod: { type: String, default: 'Account login details will be delivered after admin approval.' },
  deliveryMode: {
    type: String,
    enum: ['credentials', 'activation_code', 'login_code', 'manual'],
    default: 'credentials'
  },
  deliveryInstruction: { type: String, default: '' },
  deliveryVideoUrl: { type: String, default: '' },
  deliveryImageUrl: { type: String, default: '' },
  passwordInstructionVideoUrl: { type: String, default: '' },
  manualInputMode: {
    type: String,
    enum: ['ideogram_credentials', 'email_password', 'email_only'],
    default: 'ideogram_credentials'
  },
  backorderStock: { type: Number, default: 0, min: 0 },
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
