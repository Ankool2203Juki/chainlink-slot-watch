import { Contract, JsonRpcProvider, formatUnits } from "ethers";

const POOL = "0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e";
const STAKING_URL = "https://staking.chain.link/";
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

async function telegram(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!r.ok) throw new Error(`Telegram error: ${r.status} ${await r.text()}`);
}

async function check(env) {
  const rpc = env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
  const provider = new JsonRpcProvider(rpc);
  const pool = new Contract(POOL, ABI, provider);
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

  console.log(JSON.stringify({
    block, active, maxPoolLINK: maxLink,
    totalPrincipalLINK: stakedLink,
    availableLINK: availableLink,
    observedAtVN: vnTime()
  }));

  if (active && available > 0n) {
    await telegram(env, `🚨🚨 CHAINLINK COMMUNITY STAKING SLOT OPEN 🚨🚨

⚡ 1-minute monitor detected verifiable capacity.

Available: ${availableLink} LINK
Pool: ${stakedLink} / ${maxLink} LINK
Ethereum block: ${block}
Observed: ${vnTime()} Asia/Ho_Chi_Minh

Official staking: ${STAKING_URL}

⚠️ Verify the domain is exactly staking.chain.link and check Ethereum gas before connecting your wallet.
Never enter a seed phrase/private key into a website or bot.`);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(check(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("Chainlink Slot Watch worker is alive.", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }
};
