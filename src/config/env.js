import dotenv from 'dotenv';
dotenv.config();

const required = ['MONGODB_URI', 'JWT_SECRET', 'ENCRYPTION_KEY_BASE64'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env variable: ${key}`);
  }
}

const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY_BASE64, 'base64');
if (encryptionKey.length !== 32) {
  throw new Error('ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`,
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'Ai Market',
    replyTo: process.env.EMAIL_REPLY_TO || process.env.SMTP_USER || ''
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    lowStockLimit: Math.max(0, Number(process.env.TELEGRAM_LOW_STOCK_LIMIT || 1))
  },
  adminSeedSecret: process.env.ADMIN_SEED_SECRET,
  encryptionKey
};
