import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true },
  orderId: { type: String, default: '', index: true },
  kind: { type: String, enum: ['order_charge', 'order_reversal', 'payment', 'discount'], default: 'order_charge' },
  currency: { type: String, enum: ['BDT', 'PKR', 'USDT', 'USD'], default: 'BDT', index: true },
  amount: { type: Number, default: 0 },
  note: { type: String, default: '' }, paymentReference: { type: String, default: '' }, receiptNo: { type: String, default: '' },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }, createdByNickname: { type: String, default: '' }
}, { timestamps: true });
schema.index({ resellerId: 1, createdAt: -1 });
export const ResellerLedger = mongoose.model('ResellerLedger', schema);
