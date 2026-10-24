import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  productSnapshot: {
    title: String,
    logoUrl: { type: String, default: '' },
    icon: { type: String, default: '✨' },
    deliveryMode: { type: String, default: 'credentials' },
    manualInputMode: { type: String, default: 'ideogram_credentials' },
    backorder: { type: Boolean, default: false },
    deliveryInstruction: { type: String, default: '' },
    deliveryVideoUrl: { type: String, default: '' },
    deliveryImageUrl: { type: String, default: '' },
    price: Number,
    originalAmount: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    purchaseCost: { type: Number, default: 0 },
    accountCost: { type: Number, default: 0 },
    paymentGatewayFee: { type: Number, default: 0 },
    otherExpense: { type: Number, default: 0 },
    currency: String,
    priceRegion: { type: String, enum: ['bd', 'pk', 'world'], default: 'world' }
  },
  customer: {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    whatsapp: { type: String, default: '' }
  },
  paymentMethod: { type: String, enum: ['bangladesh', 'pakistan', 'binance', 'reseller_due', 'free'], required: true },
  priceRegion: { type: String, enum: ['bd', 'pk', 'world'], default: 'world', index: true },
  detectedCountry: { type: String, default: 'XX' },
  transactionId: { type: String, default: '', trim: true },
  paymentNote: String,
  customerOrderRef: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'delivered', 'cancelled'], default: 'pending', index: true },
  accessTokenHash: { type: String, required: true },
  assignedStockItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', default: null },
  supplier: {
    provider: { type: String, default: '' },
    productId: { type: String, default: '' },
    packageId: { type: String, default: '' },
    partnerOrderId: { type: String, default: '' },
    externalOrderId: { type: String, default: '' },
    status: { type: String, default: '' },
    reservedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancelPending: { type: Boolean, default: false },
    lastAttemptAt: Date,
    lastError: { type: String, default: '' }
  },
  fulfillment: {
    isBackorder: { type: Boolean, default: false },
    deliveryDetailsAddedAt: { type: Date, default: null },
    deliveryDetailsAddedByNickname: { type: String, default: '' }
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  reviewedByNickname: { type: String, default: '' },
  reviewedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  approvedByNickname: { type: String, default: '' },
  approvedAt: Date,
  deliveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  deliveredByNickname: { type: String, default: '' },
  deliveredAt: Date,
  adminSettlementId: { type: String, default: null, index: true },
  adminDueSettledAt: { type: Date, default: null, index: true },
  adminDueSettledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  adminDueSettledByNickname: { type: String, default: '' },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  rejectedByNickname: { type: String, default: '' },
  rejectedAt: Date,
  rejectReason: String,
  deliveryViewedAt: Date,
  ipAddress: String,
  userAgent: String
}, { timestamps: true, strict: false });

orderSchema.index({ 'customer.email': 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
export const Order = mongoose.model('Order', orderSchema);
