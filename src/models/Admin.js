import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nickname: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['owner', 'admin'], default: 'admin', index: true },
  isActive: { type: Boolean, default: true, index: true },
  createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByNickname: { type: String, default: '' },
  lastLoginAt: Date
}, { timestamps: true });

adminSchema.pre('validate', function(next) {
  if (!this.nickname && this.name) this.nickname = this.name;
  if (!this.name && this.nickname) this.name = this.nickname;
  next();
});

export const Admin = mongoose.model('Admin', adminSchema);
