import { ActivityLog } from '../models/ActivityLog.js';

export async function logActivity(admin, action, entityType, entityId, message, meta = {}) {
  try {
    await ActivityLog.create({
      actorAdminId: admin?._id || null,
      actorNickname: admin?.nickname || admin?.name || 'system',
      action,
      entityType,
      entityId: entityId ? String(entityId) : '',
      message,
      meta
    });
  } catch (err) {
    console.error('Activity log failed:', err.message);
  }
}
