import { Contract, JsonRpcProvider, formatUnits } from "ethers";

const POOL = "0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e";
const STAKING_URL = "https://staking.chain.link/";
const RPC_URL = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ABI = [
  "function getMaxPoolSize() view returns (uint256)",
  "function getTotalPrincipal() view returns (uint256)",
  "function isActive() view returns (bool)"
];

function vnTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).format(new Date());
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Telegram secrets are missing");
  }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!r.ok) throw new Error(`Telegram error: ${r.status} ${await r.text()}`);
}

const provider = new JsonRpcProvider(RPC_URL);
const pool = new Contract(POOL, ABI, provider);

try {
  // Read all values from the same latest block to avoid inconsistent snapshots.
  const block = await provider.getBlockNumber();
  const opts = { blockTag: block };
  const [maxPool, totalPrincipal, active] = await Promise.all([
    pool.getMaxPoolSize(opts),
    pool.getTotalPrincipal(opts),
    pool.isActive(opts)
  ]);

  const available = maxPool > totalPrincipal ? maxPool - totalPrincipal : 0n;
  const availableLink = formatUnits(available, 18);
  const maxLink = formatUnits(maxPool, 18);
  const stakedLink = formatUnits(totalPrincipal, 18);

  console.log({
    block,
    active,
    maxPoolLINK: maxLink,
    totalPrincipalLINK: stakedLink,
    availableLINK: availableLink,
    observedAtVN: vnTime()
  });

  // Only alert when the official pool contract is active AND capacity is actually open.
  if (active && available > 0n) {
    await telegram(
      `🚨 CHAINLINK COMMUNITY STAKING SLOT OPEN

Available: ${availableLink} LINK
Pool: ${stakedLink} / ${maxLink} LINK
Ethereum block: ${block}
Observed: ${vnTime()} Asia/Ho_Chi_Minh

Official staking: ${STAKING_URL}

⚠️ Before connecting a wallet:
• Verify the domain is exactly staking.chain.link
• Check current Ethereum gas
• Never enter a seed phrase/private key into a website or bot`
    );
    console.log("Telegram alert sent.");
  } else {
    console.log("No verifiable Community Pool capacity. No notification sent.");
  }
} catch (err) {
  console.error("Capacity check failed; refusing to send an availability alert.", err);
  process.exitCode = 1;
}
