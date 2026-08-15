import mongoose from 'mongoose';

const visitorSchema = new mongoose.Schema({
  visitorId: { type: String, required: true, unique: true, index: true, maxlength: 128 },
  lastSessionId: { type: String, default: '', maxlength: 128 },
  visitCount: { type: Number, default: 1, min: 1 },
  firstSeenAt: { type: Date, default: Date.now, index: true },
  lastSeenAt: { type: Date, default: Date.now, index: true },
  lastPath: { type: String, default: '/', maxlength: 220 },
  referrerHost: { type: String, default: '', maxlength: 180 }
}, { timestamps: true });

visitorSchema.index({ lastSeenAt: -1 });

export const Visitor = mongoose.model('Visitor', visitorSchema);
