import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  type: { type: String, required: true, index: true }, to: { type: String, required: true, lowercase: true, trim: true, index: true }, subject: { type: String, default: '' }, entityId: { type: String, default: '' },
  status: { type: String, enum: ['queued', 'sent', 'failed', 'not_configured'], default: 'queued', index: true }, messageId: { type: String, default: '' }, error: { type: String, default: '' }, meta: { type: Object, default: {} }, sentAt: Date
}, { timestamps: true, strict: false });
export const EmailNotification = mongoose.model('EmailNotification', schema);
