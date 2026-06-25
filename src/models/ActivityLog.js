import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema({
  actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  actorNickname: { type: String, default: '' },
  action: { type: String, required: true, index: true },
  entityType: { type: String, default: '' },
  entityId: { type: String, default: '' },
  message: { type: String, required: true },
  meta: { type: Object, default: {} }
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });

export const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
