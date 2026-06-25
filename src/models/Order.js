import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  productSnapshot: {
    title: String,
    price: Number,
    currency: String,
    priceRegion: { type: String, enum: ['bd', 'pk', 'world'], default: 'world' }
  },
  customer: {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    whatsapp: { type: String, default: '' }
  },
  paymentMethod: { type: String, enum: ['bangladesh', 'pakistan', 'binance'], required: true },
  priceRegion: { type: String, enum: ['bd', 'pk', 'world'], default: 'world', index: true },
  detectedCountry: { type: String, default: 'XX' },
  transactionId: { type: String, required: true, trim: true },
  paymentNote: String,
  customerOrderRef: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'delivered'], default: 'pending', index: true },
  accessTokenHash: { type: String, required: true },
  assignedStockItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  reviewedByNickname: { type: String, default: '' },
  reviewedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  approvedByNickname: { type: String, default: '' },
  approvedAt: Date,
  deliveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  deliveredByNickname: { type: String, default: '' },
  deliveredAt: Date,
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  rejectedByNickname: { type: String, default: '' },
  rejectedAt: Date,
  rejectReason: String,
  deliveryViewedAt: Date,
  ipAddress: String,
  userAgent: String
}, { timestamps: true });

orderSchema.index({ 'customer.email': 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ transactionId: 1, paymentMethod: 1 }, { unique: true });

export const Order = mongoose.model('Order', orderSchema);
