import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { publicLimiter } from './middleware/rateLimits.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { publicRouter } from './routes/publicRoutes.js';
import { adminRouter } from './routes/adminRoutes.js';
import { Admin } from './models/Admin.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: env.nodeEnv === 'production' ? [env.frontendUrl] : true,
  credentials: false
}));
app.use(express.json({ limit: '200kb' }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(publicLimiter);

app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);


app.get('/api/setup/create-admin', async (req, res, next) => {
  try {
    if (process.env.ALLOW_ADMIN_SEED !== 'true') {
      return res.status(403).json({ error: 'Admin setup disabled' });
    }

    const email = process.env.ADMIN_SETUP_EMAIL;
    const password = process.env.ADMIN_SETUP_PASSWORD;
    const name = process.env.ADMIN_SETUP_NAME || 'shimul';
    const nickname = process.env.ADMIN_SETUP_NICKNAME || name;

    if (!email || !password || password.length < 10) {
      return res.status(400).json({
        error: 'Set ADMIN_SETUP_EMAIL and ADMIN_SETUP_PASSWORD. Password must be at least 10 characters.'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(password, 12);

    const admin = await Admin.findOneAndUpdate(
      { email: normalizedEmail },
      {
        name,
        nickname,
        email: normalizedEmail,
        passwordHash,
        role: 'owner',
        isActive: true
      },
      { upsert: true, new: true }
    );

    return res.json({
      ok: true,
      message: 'Admin created successfully. IMPORTANT: set ALLOW_ADMIN_SEED=false or remove ADMIN_SETUP_PASSWORD now.',
      email: admin.email
    });
  } catch (err) {
    return next(err);
  }
});

app.use(notFound);
app.use(errorHandler);

connectDb()
  .then(() => {
    app.listen(env.port, () => {
      console.log(`API running on port ${env.port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
