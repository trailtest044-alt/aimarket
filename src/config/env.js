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
  adminSeedSecret: process.env.ADMIN_SEED_SECRET,
  encryptionKey
};
