import { Reseller } from '../models/Reseller.js';
import { ResellerInvoice } from '../models/ResellerInvoice.js';
import { ResellerLedger } from '../models/ResellerLedger.js';
import { sendResellerPaymentReceipt } from './notificationEmail.js';

export function resellerLedgerBalances(entries) {
  return entries.reduce((all, entry) => ({ ...all, [entry.currency]: Number(all[entry.currency] || 0) + Number(entry.amount || 0) }), {});
}

export async function settleResellerPayment({ resellerId, amount, currency = 'BDT', discount = 0, paymentReference = '', note = '', admin }) {
  const reseller = await Reseller.findById(resellerId).lean();
  if (!reseller) throw new Error('Reseller not found');
  const invoices = await ResellerInvoice.find({ resellerId: reseller._id, currency, status: { $in: ['open', 'partial'] } }).sort({ createdAt: 1 }).lean();
  const outstanding = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0);
  if (!invoices.length || outstanding <= 0) throw new Error(`There is no open ${currency} due to settle.`);
  if (Number(amount) > outstanding + 0.01) throw new Error(`Settlement amount is more than the open ${currency} due (${outstanding}).`);
  if (Number(discount) > Number(amount) + 0.01) throw new Error('Discount cannot be greater than the settlement amount.');
  const settlementAmount = Math.min(Number(amount), outstanding);
  const discountApplied = Math.min(Number(discount), settlementAmount);
  const paymentReceived = Math.max(0, Math.round((settlementAmount - discountApplied) * 100) / 100);
  const receiptNo = `RSL-${Date.now()}-${String(reseller._id).slice(-4).toUpperCase()}`;
  const actor = admin?.nickname || admin?.name || 'Owner';
  const records = [];
  if (paymentReceived > 0) records.push(await ResellerLedger.create({ resellerId: reseller._id, kind: 'payment', currency, amount: -paymentReceived, paymentReference, note: note || `Reseller payment (${receiptNo})`, receiptNo, createdByAdminId: admin?._id || null, createdByNickname: actor }));
  if (discountApplied > 0) records.push(await ResellerLedger.create({ resellerId: reseller._id, kind: 'discount', currency, amount: -discountApplied, note: `Admin discount (${receiptNo})`, receiptNo, createdByAdminId: admin?._id || null, createdByNickname: actor }));
  let cashLeft = paymentReceived; let discountLeft = discountApplied; const allocations = [];
  for (const invoice of invoices) {
    const remaining = Number(invoice.remainingAmount || 0); if (remaining <= 0 || cashLeft + discountLeft <= 0) continue;
    const paymentApplied = Math.min(remaining, cashLeft); const discountForInvoice = Math.min(remaining - paymentApplied, discountLeft);
    const nextRemaining = Math.max(0, Math.round((remaining - paymentApplied - discountForInvoice) * 100) / 100);
    cashLeft -= paymentApplied; discountLeft -= discountForInvoice;
    await ResellerInvoice.findByIdAndUpdate(invoice._id, { $set: { paidAmount: Number(invoice.paidAmount || 0) + paymentApplied, discountAmount: Number(invoice.discountAmount || 0) + discountForInvoice, remainingAmount: nextRemaining, status: nextRemaining === 0 ? 'paid' : 'partial', lastReceiptNo: receiptNo } });
    allocations.push({ invoiceNo: invoice.orderId, paymentApplied, discountApplied: discountForInvoice, remainingAmount: nextRemaining });
  }
  const balances = resellerLedgerBalances(await ResellerLedger.find({ resellerId: reseller._id }).lean());
  const remainingDue = Math.max(0, Number(balances[currency] || 0));
  const mail = await sendResellerPaymentReceipt({ reseller, receiptNo, currency, paymentReceived, discountApplied, allocations, remainingDue });
  return { reseller, receiptNo, settlementAmount, paymentReceived, discountApplied, allocations, balances, remainingDue, records, emailStatus: mail.status };
}
