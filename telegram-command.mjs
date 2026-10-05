import { spawnSync } from "node:child_process";

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChat = String(process.env.TELEGRAM_CHAT_ID || "");
if (!token || !allowedChat) throw new Error("Telegram secrets are missing");

const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=100`);
if (!r.ok) throw new Error(await r.text());
const data = await r.json();
const now = Math.floor(Date.now() / 1000);

// Stateless scheduled polling: only act on very recent /status commands.
// This avoids replying forever to old Telegram updates.
const statuses = (data.result || []).filter(u => {
  const msg = u.message;
  return msg &&
    String(msg.chat?.id) === allowedChat &&
    /^\/status(?:@\w+)?\s*$/i.test(msg.text || "") &&
    now - Number(msg.date || 0) >= 0 &&
    now - Number(msg.date || 0) < 290;
});

if (!statuses.length) {
  console.log("No new /status command.");
  process.exit(0);
}

console.log(`Found ${statuses.length} recent /status command(s); sending one fresh status reply.`);
const child = spawnSync(process.execPath, ["monitor.mjs"], {
  stdio: "inherit",
  env: { ...process.env, STATUS_ONLY: "1" }
});
process.exit(child.status ?? 1);
