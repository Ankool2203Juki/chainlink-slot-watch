import { Contract, WebSocketProvider, JsonRpcProvider, formatUnits } from "ethers";

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
const statusProvider = new JsonRpcProvider("https://ethereum-rpc.publicnode.com");
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

async function handleTelegramUpdate(update) {
  console.log("Telegram update received");
  const m = update?.message;
  if (!m) {
    console.log("Telegram message present: NO");
    return;
  }
  const chatMatched = String(m.chat?.id) === String(TELEGRAM_CHAT_ID);
  console.log("Telegram chat matched:", chatMatched ? "YES" : "NO");
  const cmd = String(m.text || "").trim().split(" ")[0].split("@")[0].toLowerCase();
  console.log("Telegram command:", cmd || "(none)");
  if (!chatMatched || cmd !== "/status") return;
  const statusPool = new Contract(POOL, ABI, statusProvider);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Status RPC timeout")), 8000));
  const values = Promise.all([
    statusPool.getMaxPoolSize(), statusPool.getTotalPrincipal(), statusPool.isActive()
  ]);
  const [maxPool, totalPrincipal, active] = await Promise.race([values, timeout]);
  const available = maxPool > totalPrincipal ? maxPool - totalPrincipal : 0n;
  console.log("Telegram status read OK");
  await telegram("Chainlink Community Pool — REALTIME STATUS\n\nActive: " + (active ? "YES" : "NO") +
    "\nAvailable: " + formatUnits(available, 18) + " LINK\nPool: " +
    formatUnits(totalPrincipal, 18) + " / " + formatUnits(maxPool, 18) +
    " LINK\nChecked: " + vnTime() + " Asia/Ho_Chi_Minh\n\n" + STAKING_URL);
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
  provider.on("block", (n) => check(n));
  provider.websocket.onopen = () => console.log("Ethereum WebSocket connected.");
  provider.websocket.onclose = () => {
    console.error("WebSocket closed; exiting so host can restart.");
    process.exit(1);
  };
  provider.websocket.onerror = (e) => console.error("WebSocket error:", e?.message || e);

  await startHttpServer();
  await check();
}
start();
