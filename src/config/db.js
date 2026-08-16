import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongodbUri, {
    autoIndex: env.nodeEnv !== 'production'
  });
  // Older deployments made transactionId+paymentMethod unique. Batch checkout
  // intentionally shares one payment proof across several order rows.
  try {
    await mongoose.connection.collection('orders').dropIndex('transactionId_1_paymentMethod_1');
    console.log('Removed legacy order transaction unique index');
  } catch (error) {
    if (![26, 27].includes(error?.code) && error?.codeName !== 'IndexNotFound' && error?.codeName !== 'NamespaceNotFound') throw error;
  }
  console.log('MongoDB connected');
}
