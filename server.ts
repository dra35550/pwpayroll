import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import {
  getPayrollRecords,
  getEmployees,
  updatePayrollRecord,
  recordConfirmation,
  recordDispute,
  updatePayrollRecordDeliveryStatus,
  getTelegramSettings,
  saveTelegramSettings,
  addAuditLog,
  claimTelegramUpdateId,
  isTelegramUpdateProcessed,
} from './src/services/db';
import { STANDARD_SALARY_COLUMNS, getTelegramBindingStatus } from './src/utils/excelParser';
import { PayrollRecord } from './src/types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// In-memory tracker for active delivery keys to prevent concurrent double-sends
// Format: `${payrollMonth}_${employeeId}_salary_notification`
const activeDeliveries = new Set<string>();

// Track pending disputes awaiting employee text explanation
// Key: chatId, Value: { recordId, monthId, employeeId }
const pendingDisputes: Record<string, { recordId: string; monthId: string; employeeId: string }> = {};

// Local file persistence for Telegram settings in Node.js
const SETTINGS_FILE = path.join(__dirname, '.telegram_settings.json');

function readLocalSettingsFile(): Partial<{ botToken: string; botUsername: string; botName: string; isActive: boolean }> | null {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[Telegram] Could not read local settings file:', err);
  }
  return null;
}

function writeLocalSettingsFile(data: Partial<{ botToken: string; botUsername: string; botName: string; isActive: boolean }>): void {
  try {
    const existing = readLocalSettingsFile() || {};
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...existing, ...data }, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Telegram] Could not write local settings file:', err);
  }
}

/**
 * Resolves the active Telegram Bot Token from override, environment, local disk file, or Firestore settings.
 */
async function resolveBotToken(overrideToken?: string): Promise<string> {
  if (overrideToken && overrideToken.trim()) {
    return overrideToken.trim();
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim()) {
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  }
  const localSettings = readLocalSettingsFile();
  if (localSettings?.botToken && localSettings.botToken.trim()) {
    return localSettings.botToken.trim();
  }
  try {
    const settings = await getTelegramSettings();
    if (settings.botToken && settings.botToken.trim()) {
      return settings.botToken.trim();
    }
  } catch (err) {
    console.warn('[Telegram] Could not read bot token from Firestore settings:', err);
  }
  return '';
}

/**
 * Formats full salary breakdown for private Telegram display (Columns B to AC).
 * Requirements:
 * - Display only fields with actual values.
 * - Hide empty or null fields.
 * - Preserve explicitly entered zero values (format as $0.00).
 * - Format salary amounts in USD with two decimal places.
 * - Prominently display Net Salary.
 */
function formatTelegramSalaryDetails(record: PayrollRecord): string {
  const lines: string[] = [
    `📋 <b>SALARY DETAILS STATEMENT</b>`,
    `<b>Period:</b> ${record.payrollMonth}`,
    `<b>Employee ID:</b> <code>${record.employeeId}</code>`,
    `<b>Name:</b> ${record.employeeName}`,
    `<b>Department:</b> ${record.department || 'N/A'}`,
    `──────────────────────────`,
  ];

  // Map each standard column B to AC
  const fields = record.salaryFields || {};
  let hasEarnings = false;
  let hasDeductions = false;

  const earningsLines: string[] = [];
  const deductionLines: string[] = [];
  const otherLines: string[] = [];

  for (const colDef of STANDARD_SALARY_COLUMNS) {
    // Only inspect Columns B to AC
    if (colDef.colIndex < 1 || colDef.colIndex > 28) continue;

    // Check by column title, labelZh, labelEn, or column letter
    let val = fields[colDef.key];
    if (val === undefined || val === null || val === '') {
      val = fields[colDef.labelZh] ?? fields[colDef.labelEn] ?? fields[`Col_${colDef.col}`];
    }

    // Skip empty or null fields
    if (val === undefined || val === null || val === '') {
      continue;
    }

    let formattedVal = String(val);
    if (typeof val === 'number') {
      if (colDef.isAmount) {
        formattedVal = `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      } else {
        formattedVal = String(val);
      }
    } else if (colDef.isAmount && !isNaN(Number(String(val).replace(/[$,\s]/g, '')))) {
      const num = Number(String(val).replace(/[$,\s]/g, ''));
      formattedVal = `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    const line = `• <b>${colDef.labelZh}</b> (${colDef.labelEn}): ${formattedVal}`;
    if (colDef.category === 'earnings') {
      earningsLines.push(line);
      hasEarnings = true;
    } else if (colDef.category === 'deductions') {
      deductionLines.push(line);
      hasDeductions = true;
    } else {
      otherLines.push(line);
    }
  }

  if (otherLines.length > 0) {
    lines.push(`<b>Employee & Account Information:</b>`);
    lines.push(...otherLines);
    lines.push(`──────────────────────────`);
  }

  if (hasEarnings) {
    lines.push(`<b>Earnings & Allowances:</b>`);
    lines.push(...earningsLines);
    lines.push(`──────────────────────────`);
  }

  if (hasDeductions) {
    lines.push(`<b>Deductions & Advances:</b>`);
    lines.push(...deductionLines);
    lines.push(`──────────────────────────`);
  }

  const netFormatted = `$${(record.netSalary || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  lines.push(`<b>💰 NET SALARY: ${netFormatted} USD</b>`);
  lines.push(`<b>Confirmation Status:</b> ${record.confirmationStatus.toUpperCase()}`);
  if (record.confirmedAt) {
    lines.push(`<i>Confirmed on: ${new Date(record.confirmedAt).toLocaleString()}</i>`);
  }
  if (record.disputeRemark) {
    lines.push(`<i>Reported Issue: "${record.disputeRemark}"</i>`);
  }

  return lines.join('\n');
}

/**
 * Exact Telegram Bot /start Welcome Message Format in Khmer.
 * Preserves literal newline line breaks between the three lines and Khmer Unicode characters.
 */
export function buildWelcomeMessage(chatId: string): string {
  return `👉️️️️️️ សូមស្វាគមន៍មកកាន់ Prime Way

👉️️️️️️ លេខ ID: ${chatId}

👉️️️️️️ សូមផ្ញើ លេខ ID នេះទៅ HR`;
}

/**
 * Handles incoming Telegram updates (via Webhook or polling).
 * Ensures exactly ONE message per update_id via Firestore transaction.
 */
export async function processTelegramUpdate(update: any, botToken: string): Promise<boolean> {
  if (!update || typeof update !== 'object') return false;

  const updateId = update.update_id;

  // 1. Idempotency Check (Issue 10 & Critical Requirement):
  // Check whether the same Telegram update_id has already been processed.
  // CRITICAL: Do NOT mark the update as processed before the message or action is successfully executed!
  if (updateId !== undefined && updateId !== null) {
    const alreadyProcessed = await isTelegramUpdateProcessed(updateId);
    if (alreadyProcessed) {
      console.log(`[Telegram] Duplicate update_id ${updateId} skipped (already processed).`);
      return false;
    }
  }

  // 2. Handle Callback Query (Inline Buttons: View Salary Details, Confirm Salary, Report Problem)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.from?.id);
    const cbData = String(cb.data || '');
    const cbId = cb.id;

    const [action, recordId] = cbData.split(':');
    if (!action || !recordId) {
      await answerCallbackQuery(botToken, cbId, 'Invalid request action.');
      return true;
    }

    // Retrieve payroll month and employee ID from recordId (format: `${monthId}_${employeeId}`)
    const parts = recordId.split('_');
    const monthId = parts[0];
    const employeeId = parts.slice(1).join('_');

    const records = await getPayrollRecords(monthId);
    const record = records.find(r => r.payrollRecordId === recordId || r.id === recordId || r.employeeId === employeeId);

    if (!record) {
      await answerCallbackQuery(botToken, cbId, 'Salary record not found for this period.', true);
      return true;
    }

    // SECURITY REQUIREMENT:
    // Never trust an employee-supplied Employee ID or callback data without checking ownership against the registered Telegram Chat ID.
    if (!record.telegramChatId || String(record.telegramChatId).trim() !== chatId) {
      await answerCallbackQuery(
        botToken,
        cbId,
        '⛔ Security Verification Failed: You are not authorized to view or manage this salary record.',
        true
      );
      await sendTelegramMessage(
        botToken,
        chatId,
        '⛔ <b>Security Verification Failed</b>\n\nYour Telegram account does not match the registered employee for this salary statement. You can only access your own payroll details.'
      );
      return true;
    }

    if (action === 'view_details') {
      await answerCallbackQuery(botToken, cbId, 'Loading your full salary details...');
      const detailsMsg = formatTelegramSalaryDetails(record);
      await sendTelegramMessage(botToken, chatId, detailsMsg, {
        inline_keyboard: [
          [
            { text: '✅ Confirm Salary', callback_data: `confirm_salary:${recordId}` },
            { text: '⚠️ Report a Problem', callback_data: `report_problem:${recordId}` }
          ]
        ]
      });

      if (updateId !== undefined && updateId !== null) {
        await claimTelegramUpdateId(updateId, { chatId, command: action });
      }
      return true;
    }

    if (action === 'confirm_salary') {
      if (record.confirmationStatus === 'confirmed') {
        await answerCallbackQuery(botToken, cbId, 'Salary was already confirmed.', true);
        await sendTelegramMessage(botToken, chatId, `ℹ️ <b>Already Confirmed</b>\n\nYour salary for <b>${record.payrollMonth}</b> was previously confirmed on ${new Date(record.confirmedAt || Date.now()).toLocaleString()}.`);
        if (updateId !== undefined && updateId !== null) {
          await claimTelegramUpdateId(updateId, { chatId, command: action });
        }
        return true;
      }

      await recordConfirmation(record.payrollRecordId, monthId, record.employeeId, chatId, 'telegram_employee');
      await answerCallbackQuery(botToken, cbId, '✅ Salary successfully confirmed!', true);

      await sendTelegramMessage(
        botToken,
        chatId,
        `✅ <b>Salary Confirmed</b>\n\nThank you, <b>${record.employeeName}</b>!\nYour salary statement for <b>${record.payrollMonth}</b> has been securely recorded as <b>CONFIRMED</b>.\n\nNet Amount: $${record.netSalary.toFixed(2)} USD`
      );

      if (updateId !== undefined && updateId !== null) {
        await claimTelegramUpdateId(updateId, { chatId, command: action });
      }
      return true;
    }

    if (action === 'report_problem') {
      // Set pending dispute state
      pendingDisputes[chatId] = {
        recordId: record.payrollRecordId,
        monthId: record.payrollMonth,
        employeeId: record.employeeId,
      };

      await answerCallbackQuery(botToken, cbId, 'Please type and send your explanation.');
      await sendTelegramMessage(
        botToken,
        chatId,
        `⚠️ <b>Report a Problem (${record.payrollMonth})</b>\n\nPlease reply with a text message explaining the discrepancy (e.g., incorrect overtime days, missing bonus, or deduction inquiry).\n\nHR will receive your explanation directly in the CMS.`
      );

      if (updateId !== undefined && updateId !== null) {
        await claimTelegramUpdateId(updateId, { chatId, command: action });
      }
      return true;
    }
  }

  // 3. Handle Text Messages
  if (update.message) {
    const msg = update.message;
    const chatId = String(msg.chat?.id || '');
    const text = (msg.text || '').trim();

    if (!chatId) {
      console.warn('[Telegram] Received message without valid chat.id');
      return false;
    }

    // Command /start (Issues 4, 5, 6, 8, 10: Exactly ONE welcome message with proper newlines in Khmer)
    if (text === '/start' || text.startsWith('/start ') || text.startsWith('/start@')) {
      const welcomeMessage = buildWelcomeMessage(chatId);
      // Send as plain text without HTML parse_mode to preserve exact newlines and Khmer characters
      const sendRes = await sendTelegramMessage(botToken, chatId, welcomeMessage, undefined, null);
      if (sendRes.ok) {
        // CRITICAL REQUIREMENT:
        // Do not mark an update as processed before the welcome message is successfully sent!
        if (updateId !== undefined && updateId !== null) {
          await claimTelegramUpdateId(updateId, {
            chatId,
            command: '/start',
            messageId: sendRes.result?.message_id,
          });
        }
        console.log(`[Telegram] Successfully delivered /start welcome message to chat ${chatId} (update_id: ${updateId}, msg_id: ${sendRes.result?.message_id})`);
        return true;
      } else {
        console.error(`[Telegram] Failed to send /start welcome message to chat ${chatId}:`, sendRes.description, `(error_code: ${sendRes.error_code})`);
        // Do NOT mark as processed when sending fails, so Telegram retry or subsequent clicks can succeed
        return false;
      }
    }

    // Check if employee is replying to a pending dispute
    if (pendingDisputes[chatId]) {
      const disputeInfo = pendingDisputes[chatId];
      delete pendingDisputes[chatId];

      await recordDispute(
        disputeInfo.recordId,
        disputeInfo.monthId,
        disputeInfo.employeeId,
        chatId,
        text,
        'telegram_employee'
      );

      await sendTelegramMessage(
        botToken,
        chatId,
        `📝 <b>Dispute Recorded</b>\n\nYour message has been forwarded to HR:\n<i>"${text}"</i>\n\nHR will review your statement and contact you.`
      );

      if (updateId !== undefined && updateId !== null) {
        await claimTelegramUpdateId(updateId, { chatId, command: 'dispute_reply' });
      }
      return true;
    }

    // Default response for other messages
    const defRes = await sendTelegramMessage(
      botToken,
      chatId,
      `Hello! Your Telegram Chat ID is: <code>${chatId}</code>\n\nPlease provide this Chat ID to HR to receive your monthly salary statements.`
    );
    if (defRes.ok && updateId !== undefined && updateId !== null) {
      await claimTelegramUpdateId(updateId, { chatId, command: 'other' });
    }
    return true;
  }

  return true;
}

/**
 * Sends a message via Telegram Bot API.
 * Allows setting parseMode to null for plain text messages with natural line breaks.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup?: any,
  parseMode: 'HTML' | 'Markdown' | null = 'HTML'
): Promise<{ ok: boolean; result?: any; description?: string; error_code?: number }> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body: Record<string, any> = {
      chat_id: chatId,
      text,
    };
    if (parseMode) {
      body.parse_mode = parseMode;
    }
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return data;
  } catch (err: any) {
    return { ok: false, description: err?.message || 'Network error communicating with Telegram API' };
  }
}

/**
 * Answers a Telegram callback query.
 */
async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false
): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      }),
    });
  } catch (err) {
    console.error('Error answering callback query:', err);
  }
}

// ---------------------- API ROUTES ----------------------

let cachedWebhookActive: boolean | null = null;
let lastCheckedWebhookTime = 0;

/**
 * Checks whether an active webhook is registered on Telegram's servers.
 * Caches result for 8 seconds to avoid rate limits.
 */
async function isWebhookActiveOnTelegram(botToken: string): Promise<boolean> {
  const now = Date.now();
  if (cachedWebhookActive !== null && now - lastCheckedWebhookTime < 8000) {
    return cachedWebhookActive;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const data = await res.json();
    lastCheckedWebhookTime = now;
    if (data.ok && data.result?.url && typeof data.result.url === 'string' && data.result.url.trim().length > 0) {
      cachedWebhookActive = true;
      return true;
    }
    cachedWebhookActive = false;
    return false;
  } catch (err) {
    console.warn('[Telegram] Could not check getWebhookInfo:', err);
    return cachedWebhookActive ?? false;
  }
}

/**
 * Automatically configures or verifies the Telegram Webhook with Telegram servers.
 */
export async function syncTelegramWebhook(botToken: string): Promise<{
  ok: boolean;
  message: string;
  webhookUrl?: string;
  telegramResult?: any;
}> {
  try {
    const rawAppUrl = process.env.APP_URL || '';
    const cleanAppUrl = rawAppUrl.trim().replace(/\/$/, '');
    if (!cleanAppUrl || cleanAppUrl === 'MY_APP_URL') {
      return { ok: false, message: 'APP_URL environment variable is not configured.' };
    }

    const targetWebhookUrl = `${cleanAppUrl}/api/telegram/webhook`;
    const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const infoData = await infoRes.json();

    if (infoData.ok && infoData.result?.url === targetWebhookUrl) {
      cachedWebhookActive = true;
      return {
        ok: true,
        message: `Webhook is already configured and pointing to ${targetWebhookUrl}`,
        webhookUrl: targetWebhookUrl,
        telegramResult: infoData.result,
      };
    }

    const setRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetWebhookUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const setData = await setRes.json();
    if (setData.ok) {
      cachedWebhookActive = true;
      console.log(`[Telegram] Webhook successfully registered: ${targetWebhookUrl}`);
      return {
        ok: true,
        message: `Webhook successfully registered: ${targetWebhookUrl}`,
        webhookUrl: targetWebhookUrl,
        telegramResult: setData.result,
      };
    } else {
      console.warn(`[Telegram] Failed to set webhook:`, setData.description);
      return {
        ok: false,
        message: setData.description || 'Failed to set webhook',
      };
    }
  } catch (err: any) {
    console.error('[Telegram] Error syncing webhook:', err);
    return { ok: false, message: err?.message || 'Error registering webhook' };
  }
}

/**
 * GET /api/telegram/status
 * Returns current bot connectivity status, webhook status, and delivery mode.
 */
app.get('/api/telegram/status', async (_req: Request, res: Response) => {
  try {
    const token = await resolveBotToken();
    const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
    const expectedWebhookUrl = appUrl ? `${appUrl}/api/telegram/webhook` : '';

    if (!token) {
      res.json({
        configured: false,
        message: 'Telegram Bot Token not configured',
        appUrl,
        expectedWebhookUrl,
      });
      return;
    }

    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = await meRes.json();

    if (!meData.ok) {
      res.json({
        configured: false,
        error: meData.description || 'Invalid Telegram Bot Token',
        appUrl,
        expectedWebhookUrl,
      });
      return;
    }

    let webhookInfo: any = null;
    try {
      const whRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const whData = await whRes.json();
      if (whData.ok) {
        webhookInfo = whData.result;
      }
    } catch (whErr) {
      console.warn('[Telegram] Could not fetch getWebhookInfo:', whErr);
    }

    const isWebhookActive = !!(webhookInfo?.url && typeof webhookInfo.url === 'string' && webhookInfo.url.length > 0);
    const webhookMatchesApp = expectedWebhookUrl ? webhookInfo?.url === expectedWebhookUrl : false;

    res.json({
      configured: true,
      botUsername: meData.result.username,
      botName: meData.result.first_name,
      canJoinGroups: meData.result.can_join_groups,
      appUrl,
      expectedWebhookUrl,
      webhook: {
        active: isWebhookActive,
        url: webhookInfo?.url || '',
        matchesAppUrl: webhookMatchesApp,
        pendingUpdateCount: webhookInfo?.pending_update_count || 0,
        lastErrorDate: webhookInfo?.last_error_date ? new Date(webhookInfo.last_error_date * 1000).toISOString() : null,
        lastErrorMessage: webhookInfo?.last_error_message || null,
        maxConnections: webhookInfo?.max_connections || 40,
      },
      activeMode: isWebhookActive ? 'webhook' : 'polling',
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to check Telegram status' });
  }
});

/**
 * POST /api/telegram/settings
 * Update and test Telegram bot token with disk + Firestore persistence and webhook registration.
 */
app.post('/api/telegram/settings', async (req: Request, res: Response) => {
  try {
    const { botToken, adminEmail } = req.body;
    if (!botToken || !String(botToken).trim()) {
      res.status(400).json({ error: 'Bot Token is required' });
      return;
    }

    const cleanToken = String(botToken).trim();
    const meRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const meData = await meRes.json();

    if (!meData.ok) {
      res.status(400).json({
        error: `Telegram validation failed: ${meData.description || 'Invalid token'}`,
      });
      return;
    }

    // 1. Write to local file on disk
    writeLocalSettingsFile({
      botToken: cleanToken,
      botUsername: meData.result.username,
      botName: meData.result.first_name,
      isActive: true,
    });

    // 2. Write to Firestore
    await saveTelegramSettings(
      {
        botToken: cleanToken,
        botUsername: meData.result.username,
        botName: meData.result.first_name,
        isActive: true,
      },
      adminEmail || 'admin'
    );

    // 3. Auto-sync webhook with Telegram API if APP_URL is configured
    const webhookSyncResult = await syncTelegramWebhook(cleanToken);

    res.json({
      success: true,
      botUsername: meData.result.username,
      botName: meData.result.first_name,
      webhookSync: webhookSyncResult,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save Telegram settings' });
  }
});

/**
 * POST /api/telegram/webhook/setup
 * Manually registers or updates the Telegram webhook with Telegram servers.
 */
app.post('/api/telegram/webhook/setup', async (_req: Request, res: Response) => {
  try {
    const token = await resolveBotToken();
    if (!token) {
      res.status(400).json({ error: 'Telegram Bot Token is not configured' });
      return;
    }
    const result = await syncTelegramWebhook(token);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to setup webhook' });
  }
});

/**
 * POST /api/telegram/webhook/delete
 * Removes Telegram webhook to allow fallback polling mode.
 */
app.post('/api/telegram/webhook/delete', async (_req: Request, res: Response) => {
  try {
    const token = await resolveBotToken();
    if (!token) {
      res.status(400).json({ error: 'Telegram Bot Token is not configured' });
      return;
    }
    const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    const delData = await delRes.json();
    cachedWebhookActive = false;
    res.json({
      success: delData.ok,
      message: delData.ok ? 'Webhook removed. Polling mode activated.' : delData.description,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to delete webhook' });
  }
});

/**
 * POST /api/telegram/test-welcome
 * Diagnostic endpoint to test sending the exact Khmer welcome message directly to a Chat ID.
 */
app.post('/api/telegram/test-welcome', async (req: Request, res: Response) => {
  try {
    const { chatId } = req.body;
    if (!chatId) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }
    const token = await resolveBotToken();
    if (!token) {
      res.status(400).json({ error: 'Telegram Bot Token is not configured' });
      return;
    }
    const welcomeMsg = buildWelcomeMessage(String(chatId));
    const sendRes = await sendTelegramMessage(token, String(chatId), welcomeMsg, undefined, null);
    res.json({
      sent: sendRes.ok,
      chatId,
      welcomeMessage: welcomeMsg,
      telegramResponse: sendRes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to send test welcome message' });
  }
});

/**
 * POST /api/telegram/send-salary
 * Core function sendPayrollBatch satisfying Sections B, C, E, F, G.
 */
app.post('/api/telegram/send-salary', async (req: Request, res: Response) => {
  const { monthId, recordIds, adminEmail, botTokenOverride, retryFailedOnly } = req.body;

  if (!monthId) {
    res.status(400).json({ error: 'Month ID is required' });
    return;
  }

  const token = await resolveBotToken(botTokenOverride);
  if (!token) {
    res.status(400).json({
      error: 'Telegram Bot Token is not configured. Please configure it in Telegram Bot Settings or set TELEGRAM_BOT_TOKEN environment variable.',
    });
    return;
  }

  try {
    // 1. Load selected payroll month and records
    const allRecords = await getPayrollRecords(monthId);
    if (allRecords.length === 0) {
      res.status(400).json({ error: `No payroll records found for ${monthId}` });
      return;
    }

    // Filter to requested records if specified
    const targetRecords = recordIds && Array.isArray(recordIds) && recordIds.length > 0
      ? allRecords.filter(r => recordIds.includes(r.payrollRecordId) || recordIds.includes(r.id) || recordIds.includes(r.employeeId))
      : allRecords;

    // 2. Load employees to ensure fresh matching
    const employees = await getEmployees();
    const empMap = new Map<string, typeof employees[0]>();
    for (const emp of employees) {
      if (emp.employeeId) empMap.set(emp.employeeId.toUpperCase(), emp);
    }

    const results: Array<{
      employeeId: string;
      employeeName: string;
      chatId: string;
      status: 'sent' | 'failed' | 'skipped';
      reason?: string;
      messageId?: number;
    }> = [];

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let alreadySentCount = 0;

    for (const rec of targetRecords) {
      const deliveryKey = `${rec.payrollMonth}_${rec.employeeId}_salary_notification`;

      // DUPLICATE PREVENTION (Section E):
      // Check if already sent and not forcing retry of failed
      if (rec.messageStatus === 'sent' && !retryFailedOnly) {
        alreadySentCount++;
        skippedCount++;
        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: rec.telegramChatId || '',
          status: 'skipped',
          reason: 'Already Sent (Duplicate Prevented)',
        });
        continue;
      }

      // Concurrency lock
      if (activeDeliveries.has(deliveryKey)) {
        skippedCount++;
        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: rec.telegramChatId || '',
          status: 'skipped',
          reason: 'Delivery currently in progress',
        });
        continue;
      }

      // 3. Match employee & retrieve registered Telegram Chat ID
      const emp = empMap.get(rec.employeeId.toUpperCase());
      const registeredChatId = (emp?.telegramChatId || rec.telegramChatId || '').trim();
      const bindingStatus = getTelegramBindingStatus(registeredChatId);

      // 4. Validate Chat ID
      if (bindingStatus === 'not_registered') {
        skippedCount++;
        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: '',
          status: 'skipped',
          reason: 'Missing Telegram Account (Not Registered)',
        });
        continue;
      }

      if (bindingStatus === 'invalid_chat_id') {
        skippedCount++;
        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: registeredChatId,
          status: 'skipped',
          reason: 'Invalid Chat ID (Must be private numeric user ID, group chats not allowed)',
        });
        continue;
      }

      // Mark as sending
      activeDeliveries.add(deliveryKey);
      await updatePayrollRecord(
        rec.payrollRecordId,
        {
          messageStatus: 'sending',
          telegramChatId: registeredChatId,
          payrollMonth: monthId,
        },
        adminEmail || 'admin'
      );

      // 5. Construct message per Section C
      const abaAccount = rec.salaryFields?.['ABA账户'] || rec.salaryFields?.['ABA Account'] || emp?.abaAccount || 'N/A';
      const abaName = rec.salaryFields?.['ABA名称'] || rec.salaryFields?.['ABA Account Name'] || emp?.abaAccountName || 'N/A';
      const netSalaryFormatted = (rec.netSalary || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const messageText = [
        `Hello ${rec.employeeName},`,
        ``,
        `Your salary for ${rec.payrollMonth} is ready for review.`,
        ``,
        `<b>Salary Information:</b>`,
        ``,
        `Name: ${rec.employeeName}`,
        `ABA Account: ${abaAccount}`,
        `ABA Name: ${abaName}`,
        ``,
        `<b>Net Salary: $${netSalaryFormatted} USD</b>`,
        ``,
        `Please review your salary details.`,
      ].join('\n');

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '📄 View Salary Details', callback_data: `view_details:${rec.payrollRecordId}` },
            { text: '✅ Confirm Salary', callback_data: `confirm_salary:${rec.payrollRecordId}` },
          ],
          [
            { text: '⚠️ Report a Problem', callback_data: `report_problem:${rec.payrollRecordId}` },
          ],
        ],
      };

      // 6. Send private message via Telegram API
      const sendRes = await sendTelegramMessage(token, registeredChatId, messageText, inlineKeyboard);

      activeDeliveries.delete(deliveryKey);

      // 7. Save each Telegram API result to Firestore (Section B.10)
      if (sendRes.ok && sendRes.result?.message_id) {
        sentCount++;
        await updatePayrollRecordDeliveryStatus(
          rec.payrollRecordId,
          monthId,
          rec.employeeId,
          'sent',
          registeredChatId,
          sendRes.result.message_id
        );

        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: registeredChatId,
          status: 'sent',
          messageId: sendRes.result.message_id,
        });
      } else {
        failedCount++;
        const errorDesc = sendRes.description || 'Failed to send message via Telegram';
        await updatePayrollRecordDeliveryStatus(
          rec.payrollRecordId,
          monthId,
          rec.employeeId,
          'failed',
          registeredChatId,
          undefined,
          errorDesc
        );

        results.push({
          employeeId: rec.employeeId,
          employeeName: rec.employeeName,
          chatId: registeredChatId,
          status: 'failed',
          reason: errorDesc,
        });
      }

      // Small pacing to avoid Telegram burst rate limits
      await new Promise(r => setTimeout(r, 60));
    }

    await addAuditLog(
      'telegram_batch_sent',
      `Sent salary batch for ${monthId}: ${sentCount} sent, ${failedCount} failed, ${skippedCount} skipped`,
      adminEmail || 'admin'
    );

    res.json({
      success: true,
      monthId,
      total: targetRecords.length,
      sentCount,
      failedCount,
      skippedCount,
      alreadySentCount,
      results,
    });
  } catch (err: any) {
    console.error('Error during batch send:', err);
    res.status(500).json({ error: err?.message || 'Internal server error during payroll batch sending' });
  }
});

let isPollingTickRunning = false;
let lastUpdateId = 0;

/**
 * POST /api/telegram/webhook
 * Public webhook endpoint for Telegram callbacks and messages.
 * Return HTTP 200 promptly after processing the update.
 */
app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
  try {
    const token = await resolveBotToken();
    if (!token) {
      console.warn('[Telegram Webhook] Received update but Bot Token is not configured. Returning 200 OK.');
      res.status(200).send('OK');
      return;
    }

    const update = req.body;
    if (update && typeof update === 'object') {
      const uId = update.update_id;
      const fromId = update.message?.chat?.id || update.callback_query?.from?.id || 'unknown';
      const summary = update.message?.text || update.callback_query?.data || 'update';
      console.log(`[Telegram Webhook] Update ${uId} from chat ${fromId}: "${summary}"`);
      await processTelegramUpdate(update, token);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Telegram Webhook Error]:', err);
    res.status(200).send('OK');
  }
});

/**
 * POST /api/telegram/sync-updates
 * Manually sync Telegram updates (only when webhook is not active).
 */
app.post('/api/telegram/sync-updates', async (_req: Request, res: Response) => {
  try {
    const token = await resolveBotToken();
    if (!token) {
      res.json({ processed: 0, message: 'Bot token not configured' });
      return;
    }

    const webhookActive = await isWebhookActiveOnTelegram(token);
    if (webhookActive) {
      res.json({
        processed: 0,
        message: 'Active Telegram webhook is enabled on Telegram servers. getUpdates polling is disabled to prevent duplicate processing.',
      });
      return;
    }

    const pollRes = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&limit=20&timeout=0`);
    const pollData = await pollRes.json();

    if (pollData.ok && Array.isArray(pollData.result)) {
      let count = 0;
      for (const update of pollData.result) {
        if (update.update_id >= lastUpdateId) {
          lastUpdateId = update.update_id;
        }
        await processTelegramUpdate(update, token);
        count++;
      }
      res.json({ processed: count });
    } else {
      res.json({ processed: 0, error: pollData.description });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to sync updates' });
  }
});

// ---------------------- VITE & STATIC FILES ----------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 HR Salary CMS Server running on http://localhost:${PORT}`);
  });
}

/**
 * Background poller:
 * CRITICAL REQUIREMENT:
 * - Check that there is only one active Telegram update processing method.
 * - Do not run getUpdates polling and webhook processing simultaneously.
 * - If Telegram has a webhook registered, polling is automatically bypassed.
 */
if (process.env.NODE_ENV !== 'test') {
  setInterval(async () => {
    if (isPollingTickRunning) {
      return;
    }

    isPollingTickRunning = true;
    try {
      const token = await resolveBotToken();
      if (!token) return;

      // Single active handler check: verify whether a webhook is registered on Telegram
      const webhookActive = await isWebhookActiveOnTelegram(token);
      if (webhookActive) {
        return;
      }

      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&limit=10&timeout=0`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          if (update.update_id >= lastUpdateId) {
            lastUpdateId = update.update_id;
          }
          await processTelegramUpdate(update, token);
        }
      }
    } catch {
      // Silent catch for background poller
    } finally {
      isPollingTickRunning = false;
    }
  }, 3500);

  startServer();
}
