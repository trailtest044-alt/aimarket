import mongoose from 'mongoose';

const encryptedBoxSchema = new mongoose.Schema({
  v: Number,
  alg: String,
  iv: String,
  tag: String,
  data: String
}, { _id: false });

const mailTxtFileSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  accountCount: { type: Number, default: 0, min: 0 },
  encryptedAccounts: { type: encryptedBoxSchema, required: true },
  uploadedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  uploadedByNickname: { type: String, default: '' }
}, { timestamps: true });

mailTxtFileSchema.index({ createdAt: -1 });

export const MailTxtFile = mongoose.model('MailTxtFile', mailTxtFileSchema);
