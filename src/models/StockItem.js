import mongoose from 'mongoose';

const encryptedBoxSchema = new mongoose.Schema({
  v: Number,
  alg: String,
  iv: String,
  tag: String,
  data: String
}, { _id: false });

const stockItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  type: { type: String, enum: ['credentials', 'instruction'], required: true },
  encryptedPayload: { type: encryptedBoxSchema, required: true },
  status: { type: String, enum: ['available', 'reserved', 'delivered', 'disabled'], default: 'available', index: true },
  assignedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  deliveredAt: Date,
  adminNote: String
}, { timestamps: true });

stockItemSchema.index({ productId: 1, status: 1, createdAt: 1 });

export const StockItem = mongoose.model('StockItem', stockItemSchema);
