import { Interface, JsonRpcProvider, formatUnits } from "ethers";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const POOL = "0xBc10f2E862ED4502144c7d632a3459F49DFCDB5e";
const ABI = [
  "event Staked(address indexed staker, uint256 newStake, uint256 totalStake)",
  "event Unstaked(address indexed staker, uint256 amount, uint256 claimedReward)"
];
const iface = new Interface(ABI);
const topics = [iface.getEvent("Staked").topicHash, iface.getEvent("Unstaked").topicHash];
const WINDOW = 7 * 86400000;
const BLOCKS_PER_QUERY = 100;
const DATA_DIR = process.env.FLOW_DATA_DIR || "";
const file = DATA_DIR ? join(DATA_DIR, "staking-flow.json") : null;
// Reuse the already configured Alchemy WebSocket endpoint over HTTPS for log backfill.
const derivedHttpUrl = process.env.ETH_WS_URL?.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
const flowUrl = process.env.FLOW_RPC_URL || derivedHttpUrl || "https://ethereum-rpc.publicnode.com";
const rpc = new JsonRpcProvider(flowUrl, 1, { staticNetwork: true });
const fallbackRpc = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, { staticNetwork: true });
let state = { cursor: null, events: [], updatedAt: 0 };
let syncing = false;
let lastError = "";
let ready = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function save() {
  if (!file) return;
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}
export async function initFlow() {
  if (file) {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(data.events) && Number.isInteger(data.cursor)) state = data;
    } catch (e) { if (e.code !== "ENOENT") console.error("Flow data load failed:", e.message); }
  }
  ready = true;
  console.log("Flow history:", file ? "persistent directory " + DATA_DIR : "memory only; configure FLOW_DATA_DIR + Railway Volume");
}
async function scan() {
  if (syncing || !ready) return;
  syncing = true;
  lastError = "";
  try {
    const head = await rpc.getBlockNumber();
    // About 7 days of Ethereum blocks; timestamps below enforce the exact 7-day window.
    let cursor = state.cursor === null ? Math.max(0, head - 51000) : state.cursor;
    const cutoff = Date.now() - WINDOW;
    let scanned = 0;
    while (cursor <= head - 2 && scanned < 100) {
      const to = Math.min(head - 2, cursor + BLOCKS_PER_QUERY - 1);
      let logs;
      try {
        const filter = { address: POOL, topics: [topics], fromBlock: cursor, toBlock: to };
        try { logs = await rpc.getLogs(filter); }
        catch (primaryError) {
          console.warn("Flow primary RPC getLogs failed:", primaryError.shortMessage || primaryError.message);
          logs = await fallbackRpc.getLogs(filter);
        }
      } catch (e) {
        lastError = "RPC getLogs: " + (e.shortMessage || e.message) + (e.info?.error?.message ? " (" + e.info.error.message + ")" : "");
        console.error("Flow scan:", lastError);
        break;
      }
      const byBlock = new Map();
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        let timestamp = byBlock.get(log.blockNumber);
        if (!timestamp) {
          const block = await rpc.getBlock(log.blockNumber).catch(() => fallbackRpc.getBlock(log.blockNumber));
          if (!block) throw new Error("Block unavailable: " + log.blockNumber);
          timestamp = Number(block.timestamp) * 1000;
          byBlock.set(log.blockNumber, timestamp);
        }
        if (timestamp < cutoff) continue;
        state.events.push({
          id: log.transactionHash + ":" + log.index,
          time: timestamp,
          block: log.blockNumber,
          type: parsed.name === "Staked" ? "stake" : "unstake",
          amount: (parsed.name === "Staked" ? parsed.args.newStake : parsed.args.amount).toString(),
          wallet: String(parsed.args.staker).toLowerCase()
        });
      }
      const unique = new Map(state.events.map(e => [e.id, e]));
      state.events = [...unique.values()].filter(e => e.time >= cutoff).sort((a,b)=>a.time-b.time);
      cursor = to + 1;
      state.cursor = cursor;
      state.updatedAt = Date.now();
      scanned++;
      if (scanned % 5 === 0) await save();
      await sleep(150);
    }
    await save();
    if (cursor > head - 2) lastError = "";
    console.log("Flow scan progress:", state.cursor === null ? "not started" : state.cursor - 1, "of", head - 2, "events:", state.events.length);
  } catch (e) {
    lastError = e.shortMessage || e.message;
    console.error("Flow scan failed:", lastError);
  } finally { syncing = false; }
}
export function startFlowSync() {
  void scan();
  setInterval(() => void scan(), 60000);
}
export function flowReport() {
  const now = Date.now();
  const complete = state.cursor !== null && !syncing && !lastError;
  const events = state.events.filter(e => e.time >= now - WINDOW);
  const stake = events.filter(e => e.type === "stake");
  const unstake = events.filter(e => e.type === "unstake");
  const total = a => a.reduce((sum, e) => sum + BigInt(e.amount), 0n);
  const stakeSum = total(stake), unstakeSum = total(unstake);
  const net = stakeSum - unstakeSum;
  const fmt = n => Number(formatUnits(n, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const value = n => complete ? fmt(n) : "—";
  const count = n => complete ? String(n) : "—";
  const dayLabel = date => date.toLocaleDateString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" });
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now - (6 - i) * 86400000);
    const d = date.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
    const es = events.filter(e => new Date(e.time).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }) === d);
    return dayLabel(date) + "  " + (complete
      ? "+" + fmt(total(es.filter(e => e.type === "stake"))) + " / -" + fmt(total(es.filter(e => e.type === "unstake")))
      : "Chưa xác minh");
  });
  const progress = state.cursor === null ? "Chưa quét" :
    syncing ? "Đang quét lịch sử" : "Đến block " + (state.cursor - 1);
  const status = lastError ? "⚠️ LỖI ĐỒNG BỘ" : complete ? "✅ ĐÃ ĐỒNG BỘ" : "⏳ ĐANG ĐỒNG BỘ";
  return [
    "📊 LINK STAKING · 7 NGÀY",
    status,
    "",
    "📥 Stake       " + value(stakeSum) + " LINK",
    "   Giao dịch: " + count(stake.length),
    "📤 Unstake   " + value(unstakeSum) + " LINK",
    "   Giao dịch: " + count(unstake.length),
    "💠 Ròng        " + (complete ? (net >= 0n ? "+" : "") + fmt(net) + " LINK" : "—"),
    "👛 Số ví        " + count(new Set(events.map(e => e.wallet)).size),
    "",
    "📅 TỪNG NGÀY (stake / unstake)",
    ...days,
    "",
    "🔄 " + progress,
    ...(lastError ? ["⚠️ RPC: " + lastError] : []),
    "💾 " + (file ? "Thư mục đã cấu hình; cần Volume" : "RAM; chưa có Volume"),
    "",
    "ℹ️ — = chưa xác minh, không phải 0 LINK.",
    "Stake/unstake không phải mua/bán LINK."
  ].join("\n");
}
