import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true }, orderId: { type: String, required: true, index: true },
  productTitle: { type: String, default: '' }, currency: { type: String, enum: ['BDT', 'PKR', 'USDT', 'USD'], default: 'BDT' },
  originalAmount: { type: Number, default: 0, min: 0 }, paidAmount: { type: Number, default: 0, min: 0 }, discountAmount: { type: Number, default: 0, min: 0 }, remainingAmount: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['open', 'partial', 'paid', 'void'], default: 'open', index: true }, lastReceiptNo: { type: String, default: '' }
}, { timestamps: true });
schema.index({ resellerId: 1, orderId: 1 }, { unique: true });
export const ResellerInvoice = mongoose.model('ResellerInvoice', schema);
