import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  resellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true }, amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, enum: ['BDT', 'PKR', 'USDT', 'USD'], default: 'BDT' }, channel: { type: String, default: '' }, transactionId: { type: String, required: true, trim: true }, note: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true }, approvedAt: Date, approvedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }, approvedByNickname: { type: String, default: '' },
  rejectedAt: Date, rejectedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }, rejectedByNickname: { type: String, default: '' }, rejectReason: { type: String, default: '' }, receiptNo: { type: String, default: '' }
}, { timestamps: true });
schema.index({ resellerId: 1, createdAt: -1 });
export const ResellerPaymentRequest = mongoose.model('ResellerPaymentRequest', schema);
