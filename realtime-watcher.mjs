import { Contract, WebSocketProvider, formatUnits } from "ethers";

const POOL = "0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e";
const STAKING_URL = "https://staking.chain.link/";
const ABI = [
  "function getMaxPoolSize() view returns (uint256)",
  "function getTotalPrincipal() view returns (uint256)",
  "function isActive() view returns (bool)"
];

const { ETH_WS_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!ETH_WS_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Set ETH_WS_URL, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
}

function vnTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());
}

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error(`Telegram error: ${r.status} ${await r.text()}`);
}

let provider;
let checking = false;
let lastAvailable = 0n;
let lastAlertAt = 0;
let lastStatusUpdate = 0;

async function readPool(blockNumber) {
  const pool = new Contract(POOL, ABI, provider);
  const opts = blockNumber ? { blockTag: blockNumber } : {};
  const [maxPool, totalPrincipal, active] = await Promise.all([
    pool.getMaxPoolSize(opts), pool.getTotalPrincipal(opts), pool.isActive(opts)
  ]);
  const available = maxPool > totalPrincipal ? maxPool - totalPrincipal : 0n;
  return { maxPool, totalPrincipal, active, available };
}

async function check(blockNumber) {
  if (checking) return;
  checking = true;
  try {
    const { maxPool, totalPrincipal, active, available } = await readPool(blockNumber);
    const now = Date.now();
    if (active && available > 0n &&
        (lastAvailable === 0n || available > lastAvailable || now - lastAlertAt >= 15000)) {
      lastAlertAt = now;
      await telegram(`🚨 CHAINLINK SLOT — REALTIME

Available: ${formatUnits(available, 18)} LINK
Pool: ${formatUnits(totalPrincipal, 18)} / ${formatUnits(maxPool, 18)} LINK
Block: ${blockNumber ?? "latest"}
Detected: ${vnTime()} Asia/Ho_Chi_Minh

${STAKING_URL}

⚠️ Verify staking.chain.link. Never enter seed phrase/private key into a bot.`);
    }
    lastAvailable = available;
    console.log(vnTime(), "block", blockNumber ?? "latest", "available", formatUnits(available,18));
  } catch (e) {
    console.error("check failed:", e?.message || e);
  } finally {
    checking = false;
  }
}

async function pollTelegramStatus() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastStatusUpdate + 1}&timeout=0&allowed_updates=%5B%22message%22%5D`);
    if (!r.ok) throw new Error(`Telegram getUpdates: ${r.status} ${await r.text()}`);
    const data = await r.json();
    for (const u of data.result || []) {
      lastStatusUpdate = Math.max(lastStatusUpdate, u.update_id);
      const m = u.message;
      if (!m || String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) continue;
      if (!/^\/status(?:@\w+)?(?:\s|$)/i.test(m.text || "")) continue;

      const { maxPool, totalPrincipal, active, available } = await readPool();
      await telegram(`📊 Chainlink Community Pool — REALTIME STATUS

Active: ${active ? "YES" : "NO"}
Available: ${formatUnits(available, 18)} LINK
Pool: ${formatUnits(totalPrincipal, 18)} / ${formatUnits(maxPool, 18)} LINK
Checked: ${vnTime()} Asia/Ho_Chi_Minh

${STAKING_URL}`);
    }
  } catch (e) {
    console.error("Telegram status poll failed:", e?.message || e);
  }
}

async function start() {
  provider = new WebSocketProvider(ETH_WS_URL);
  provider.on("block", (n) => check(n));
  provider.websocket.onopen = () => console.log("Ethereum WebSocket connected.");
  provider.websocket.onclose = () => {
    console.error("WebSocket closed; exiting so host can restart.");
    process.exit(1);
  };
  provider.websocket.onerror = (e) => console.error("WebSocket error:", e?.message || e);

  // Railway handles /status directly. Poll every 2s for near-instant replies.
  setInterval(pollTelegramStatus, 2000);
  await check();
  await pollTelegramStatus();
}
start();
