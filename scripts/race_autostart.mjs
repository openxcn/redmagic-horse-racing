// 满员自动开赛（云端版）：GitHub Actions 里常驻轮询，报满 12 匹立即 timeStart
// 环境变量：KEEPER_PK（必填，仅含 BNB 的 keeper 钱包私钥）、RPC_URL（可选）
import { ethers } from 'ethers';

const RACE = '0x8F5a241BaD21e63d4a4553BA675CdE76363b5149';
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const PK = process.env.KEEPER_PK;
const POLL = 15000;
const RUN_MIN = Number(process.env.RUN_MIN || 340);
const SCAN = 10;

const ABI = [
  'function raceCount() view returns(uint256)',
  'function maxHorses() view returns(uint256)',
  'function minGuarantee() view returns(uint256)',
  'function minGuaranteeUsdt() view returns(uint256)',
  'function races(uint256) view returns(uint256 id,address organizer,uint8 currency,uint256 entryFee,uint8 state,uint256 startAt,uint256 endAt,uint256 pool,uint256 sponsor,uint8 raceType,uint64 startBlock)',
  'function horsesOf(uint256) view returns(uint256[])',
  'function fullAt(uint256) view returns(uint256)',
  'function rewardFunds(uint256) view returns(uint256)',
  'function timeStart(uint256)',
];

if (!PK) { console.error('缺少 KEEPER_PK'); process.exit(1); }

const p = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true, batchMaxCount: 10, timeout: 20000 });
const c = new ethers.Contract(RACE, ABI, p);
const w = new ethers.Wallet(PK, p);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(new Date().toISOString() + ' ' + m);
const done = new Set();

async function tick() {
  const [count, maxH, mg, mgU] = await Promise.all([c.raceCount(), c.maxHorses(), c.minGuarantee(), c.minGuaranteeUsdt()]);
  const n = Number(count);
  const ids = [];
  for (let id = Math.max(1, n - SCAN + 1); id <= n; id++) ids.push(id);
  const rs = await Promise.all(ids.map(id => c.races(id)));
  const open = ids.filter((id, i) => Number(rs[i].state) === 0 && !done.has(id));
  if (!open.length) return;
  const lens = await Promise.all(open.map(id => c.horsesOf(id)));
  for (let i = 0; i < open.length; i++) {
    const id = open[i];
    if (lens[i].length < Number(maxH)) continue;
    const [fullAt, fund, r] = await Promise.all([c.fullAt(id), c.rewardFunds(id), c.races(id)]);
    if (fullAt === 0n) continue;
    if (fund < (Number(r.currency) === 1 ? mgU : mg)) { log('场 #' + id + ' 满员但保证金不足，跳过'); done.add(id); continue; }
    for (let a = 1; a <= 3; a++) {
      try {
        const tx = await w.sendTransaction({ to: RACE, data: c.interface.encodeFunctionData('timeStart', [id]), gasLimit: 4000000, gasPrice: ethers.parseUnits('0.06', 'gwei'), chainId: 56 });
        log('场 #' + id + ' 满员，已开赛 tx ' + tx.hash);
        done.add(id);
        break;
      } catch (e) { log('场 #' + id + ' 开赛失败(' + a + ')：' + String(e.shortMessage || e.message).slice(0, 120)); await sleep(3000); }
    }
  }
}

log('满员自动开赛启动，地址 ' + w.address + '，轮询 ' + POLL / 1000 + ' 秒，运行 ' + RUN_MIN + ' 分钟');
const end = Date.now() + RUN_MIN * 60000;
while (Date.now() < end) {
  try { await tick(); } catch (e) { log('轮询异常：' + String(e.shortMessage || e.message).slice(0, 120)); }
  await sleep(POLL);
}
log('本轮结束，等待下一次调度');
