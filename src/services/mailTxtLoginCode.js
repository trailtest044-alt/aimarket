import { MailTxtFile } from '../models/MailTxtFile.js';
import { decryptJson } from '../utils/cryptoBox.js';

function stripHtml(value = '') {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLoginCode(message) {
  const bodyContent = message?.body?.content ? stripHtml(message.body.content) : '';
  const text = [message?.subject || '', message?.bodyPreview || '', bodyContent].join(' ');
  const patterns = [
    /\b(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\D{0,60}([0-9]{4,8})\b/i,
    /\b([0-9]{4,8})\D{0,60}(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\b/i,
    /\b(?:verification|security|login|sign[-\s]?in|one[-\s]?time|otp|code)\D{0,60}((?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])[A-Z0-9]+)\b/i,
    /\b((?=[A-Z0-9]{6,10}\b)(?=[A-Z0-9]*[0-9])[A-Z0-9]+)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function normalizeLookupEmail(email) {
  const clean = String(email || '').toLowerCase().trim();
  const atIndex = clean.indexOf('@');
  if (atIndex <= 0) return clean;
  const localPart = clean.slice(0, atIndex);
  const plusIndex = localPart.indexOf('+');
  return `${plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart}${clean.slice(atIndex)}`;
}

function messageWasSentToEmail(message, email) {
  const target = String(email || '').toLowerCase().trim();
  const recipients = [
    ...(Array.isArray(message?.toRecipients) ? message.toRecipients : []),
    ...(Array.isArray(message?.ccRecipients) ? message.ccRecipients : []),
    ...(Array.isArray(message?.bccRecipients) ? message.bccRecipients : [])
  ];
  return recipients.some((recipient) => String(recipient?.emailAddress?.address || recipient?.address || '').toLowerCase().trim() === target);
}

async function findAccount(email) {
  const target = normalizeLookupEmail(email);
  const files = await MailTxtFile.find().sort({ createdAt: -1 }).lean();
  for (const file of files) {
    let accounts = [];
    try { accounts = decryptJson(file.encryptedAccounts); } catch { accounts = []; }
    const account = Array.isArray(accounts) ? accounts.find((item) => normalizeLookupEmail(item.email) === target) : null;
    if (account) return { ...account, fileName: file.name };
  }
  return null;
}

async function requestMicrosoftAccessToken(account) {
  const endpoints = [
    'https://login.live.com/oauth20_token.srf',
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  ];
  let lastError = 'Microsoft token refresh failed';
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: account.clientId, refresh_token: account.refreshToken, grant_type: 'refresh_token', redirect_uri: 'https://login.live.com/oauth20_desktop.srf' })
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.access_token) return json.access_token;
    lastError = json.error_description || json.error || lastError;
  }
  const error = new Error(lastError);
  error.status = 502;
  error.publicMessage = 'Could not connect to this mailbox. Check the TXT refresh token/client id.';
  throw error;
}

async function fetchMessages(account) {
  const accessToken = await requestMicrosoftAccessToken(account);
  const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$top', '10');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$select', 'id,sender,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,bodyPreview,body');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error?.message || 'Microsoft inbox read failed');
    error.status = 502;
    error.publicMessage = 'Could not read the mailbox inbox right now.';
    throw error;
  }
  return Array.isArray(json.value) ? json.value : [];
}

export async function getLatestMailTxtLoginCode(email) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const account = await findAccount(cleanEmail);
  if (!account) {
    const error = new Error('Email was not found in uploaded Mail TXT files');
    error.status = 404;
    error.publicMessage = error.message;
    throw error;
  }
  const messages = await fetchMessages(account);
  for (const message of messages) {
    if (!messageWasSentToEmail(message, cleanEmail)) continue;
    const code = extractLoginCode(message);
    if (code) return { code, subject: message.subject || '', receivedAt: message.receivedDateTime || null, preview: message.bodyPreview || '', fileName: account.fileName || '' };
  }
  const error = new Error('No login code found for this exact email. Request a fresh code and try again.');
  error.status = 404;
  error.publicMessage = error.message;
  throw error;
}
