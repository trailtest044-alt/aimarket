import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  _id: String, lockUntil: Date, lastSuccessAt: Date, lastAttemptAt: Date, nextAttemptAt: Date,
  failures: { type: Number, default: 0 }, lastError: { type: String, default: '' }, imported: { type: Number, default: 0 }
}, { timestamps: true });
export const SupplierSyncState = mongoose.model('SupplierSyncState', schema);
