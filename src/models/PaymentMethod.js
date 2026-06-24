import mongoose from 'mongoose';

const paymentMethodSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, enum: ['bangladesh', 'pakistan', 'binance'] },
  title: { type: String, required: true },
  instructions: { type: String, required: true },
  accounts: [{
    label: String,
    value: String,
    note: String
  }],
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

export const PaymentMethod = mongoose.model('PaymentMethod', paymentMethodSchema);
