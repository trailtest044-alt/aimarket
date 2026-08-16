import mongoose from 'mongoose';

// Retained only so historical deployments can load cleanly. The route
// middleware rejects email login; customer authentication is Google-only.
const schema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: { type: Date, default: null }
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const EmailLoginChallenge = mongoose.model('EmailLoginChallenge', schema);
