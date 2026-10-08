import { Contract, WebSocketProvider, JsonRpcProvider, formatUnits } from "ethers";

const POOL = "0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e";
const STAKING_URL = "https://staking.chain.link/";
const ABI = [
  "function getMaxPoolSize() view returns (uint256)",
  "function getTotalPrincipal() view returns (uint256)",
  "function isActive() view returns (bool)"
];

const { ETH_WS_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_GROUP_CHAT_ID } = process.env;
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

async function telegramTo(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error(`Telegram error: ${r.status} ${await r.text()}`);
}

async function telegram(text) {
  await telegramTo(TELEGRAM_CHAT_ID, text);
  if (TELEGRAM_GROUP_CHAT_ID && String(TELEGRAM_GROUP_CHAT_ID) !== String(TELEGRAM_CHAT_ID)) {
    await telegramTo(TELEGRAM_GROUP_CHAT_ID, text);
  }
}

let provider;
const statusProvider = new JsonRpcProvider("https://ethereum-rpc.publicnode.com");
let checking = false;
let lastAvailable = 0n;
let lastAlertAt = 0;
let lastHeartbeatAt = 0;
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

async function readPool(blockNumber) {
  const pool = new Contract(POOL, ABI, statusProvider);
  const opts = {}; // HTTP RPC: avoid a stalled WebSocket contract request
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
    const { maxPool, totalPrincipal, active, available } = await Promise.race([readPool(blockNumber), new Promise((_, reject) => setTimeout(() => reject(new Error("Pool read timeout (10s)")), 10000))]);
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
    if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = now;
      const msg = "✅ CHAINLINK WATCHER ONLINE\n\n" +
        "Ethereum WebSocket: Connected\n" +
        "Last checked block: " + (blockNumber ?? "latest") + "\n" +
        "Pool active: " + (active ? "YES" : "NO") + "\n" +
        "Available: " + formatUnits(available, 18) + " LINK\n" +
        "Checked: " + vnTime() + " Asia/Ho_Chi_Minh\n" +
        "Monitoring: ACTIVE";
      await Promise.allSettled([
        telegramTo(TELEGRAM_CHAT_ID, msg),
        ...(TELEGRAM_GROUP_CHAT_ID && String(TELEGRAM_GROUP_CHAT_ID) !== String(TELEGRAM_CHAT_ID)
          ? [telegramTo(TELEGRAM_GROUP_CHAT_ID, msg)] : [])
      ]).then(results => results.forEach((r, i) => {
        if (r.status === "rejected") console.error("Heartbeat destination", i, "failed:", r.reason?.message || r.reason);
      }));
    }
  } catch (e) {
    console.error("check failed:", e?.message || e);
  } finally {
    checking = false;
  }
}

async function handleTelegramUpdate(update) {
  console.log("Telegram update received");
  const m = update?.message;
  if (!m) return;

  const chatId = String(m.chat?.id ?? "");
  const senderId = String(m.from?.id ?? "");
  const ownerId = String(TELEGRAM_CHAT_ID);
  const groupId = String(TELEGRAM_GROUP_CHAT_ID || "");
  const cmd = String(m.text || "").trim().split(" ")[0].split("@")[0].toLowerCase();
  const isPrivateOwner = chatId === ownerId;
  const isConfiguredGroup = groupId && chatId === groupId;
  const isOwnerSender = senderId === ownerId;

  console.log("Telegram command:", cmd || "(none)", "authorized:", (isPrivateOwner || isConfiguredGroup) ? "YES" : "NO");

  // Safe helper: only the bot owner can ask for a group's ID.
  if (cmd === "/chatid" && m.chat?.type !== "private" && isOwnerSender) {
    await telegramTo(chatId, "Group chat ID: " + chatId + "\n\nAdd this value in Railway as TELEGRAM_GROUP_CHAT_ID.");
    return;
  }

  if (cmd !== "/status" || (!isPrivateOwner && !isConfiguredGroup)) return;

  const statusPool = new Contract(POOL, ABI, statusProvider);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Status RPC timeout")), 8000));
  const values = Promise.all([
    statusPool.getMaxPoolSize(), statusPool.getTotalPrincipal(), statusPool.isActive()
  ]);
  const [maxPool, totalPrincipal, active] = await Promise.race([values, timeout]);
  const available = maxPool > totalPrincipal ? maxPool - totalPrincipal : 0n;
  console.log("Telegram status read OK");
  await telegramTo(chatId, "Chainlink Community Pool — REALTIME STATUS\n\nActive: " + (active ? "YES" : "NO") +
    "\nAvailable: " + formatUnits(available, 18) + " LINK\nPool: " +
    formatUnits(totalPrincipal, 18) + " / " + formatUnits(maxPool, 18) +
    " LINK\nChecked: " + vnTime() + " Asia/Ho_Chi_Minh\n\n" + STAKING_URL);
  console.log("Telegram status sent OK");
}

async function startHttpServer() {
  const http = await import("node:http");
  const port = Number(process.env.PORT || 8080);
  http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200); res.end("OK"); return;
    }
    if (req.method === "POST" && req.url === "/telegram") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        let update;
        try {
          update = JSON.parse(body || "{}");
        } catch (e) {
          console.error("Telegram webhook JSON failed:", e?.message || e);
          res.writeHead(400); res.end("BAD REQUEST"); return;
        }

        // Acknowledge Telegram immediately; do RPC/status work asynchronously.
        res.writeHead(200); res.end("OK");
        handleTelegramUpdate(update).catch(e =>
          console.error("Telegram webhook failed:", e?.message || e)
        );
      });
      return;
    }
    res.writeHead(404); res.end("Not found");
  }).listen(port, "0.0.0.0", () => console.log("HTTP webhook listening on port", port));
}

async function start() {
  provider = new WebSocketProvider(ETH_WS_URL);
  provider.on("block", (n) => { console.log("Ethereum block received:", n); void check(n); });
  provider.websocket.onopen = () => console.log("Ethereum WebSocket connected.");
  provider.websocket.onclose = () => {
    console.error("WebSocket closed; exiting so host can restart.");
    process.exit(1);
  };
  provider.websocket.onerror = (e) => console.error("WebSocket error:", e?.message || e);

  await startHttpServer();
  await check();
  // Retry independently of block subscription if the provider stops emitting blocks.
  setInterval(() => { if (!checking) void check(); }, 60000);
}
start();
