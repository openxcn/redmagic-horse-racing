// 云端 keeper：只做「满员自动开赛」。
// 结算名次与交割下注池已改为前端对所有人开放，谁点谁支付矿工费，平台不再代付。
// 环境变量：KEEPER_PK（必填，仅含 BNB 的 keeper 钱包私钥）、RPC_URL（可选）
import { ethers } from 'ethers';

const RACE = '0x8F5a241BaD21e63d4a4553BA675CdE76363b5149';
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const PK = process.env.KEEPER_PK;
const POLL = 60000;       // 开赛巡查间隔：满员后最多晚 1 分钟开跑
const RUN_MIN = Number(process.env.RUN_MIN || 340);
const SCAN = 10;          // 自动开赛扫描最近多少场

const ABI = [
  'function raceCount() view returns(uint256)',
  'function maxHorses() view returns(uint256)',
  'function autoStartGrace() view returns(uint256)',
  'function minGuarantee() view returns(uint256)',
  'function minGuaranteeUsdt() view returns(uint256)',
  'function races(uint256) view returns(uint256 id,address organizer,uint8 currency,uint256 entryFee,uint8 state,uint256 startAt,uint256 endAt,uint256 pool,uint256 sponsor,uint8 raceType,uint64 startBlock)',
  'function horsesOf(uint256) view returns(uint256[])',
  'function fullAt(uint256) view returns(uint256)',
  'function betCloseAt(uint256) view returns(uint256)',
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
const GAS = ethers.parseUnits('0.06', 'gwei');

/* 满员自动开赛：报满 12 匹且下注窗口结束后立即 timeStart */
async function autoStart() {
  const [count, maxH, grace, mg, mgU] = await Promise.all([
    c.raceCount(), c.maxHorses(), c.autoStartGrace(), c.minGuarantee(), c.minGuaranteeUsdt(),
  ]);
  const n = Number(count);
  const ids = [];
  for (let id = Math.max(1, n - SCAN + 1); id <= n; id++) ids.push(id);
  const rs = await Promise.all(ids.map(id => c.races(id)));
  const open = ids.filter((id, i) => Number(rs[i].state) === 0 && !done.has('o' + id));
  if (!open.length) return;

  const lens = await Promise.all(open.map(id => c.horsesOf(id)));
  const full = open.filter((id, i) => lens[i].length >= Number(maxH));
  if (!full.length) return;

  const now = BigInt((await p.getBlock('latest')).timestamp);
  for (const id of full) {
    const [fullAt, closeAt, fund, r] = await Promise.all([c.fullAt(id), c.betCloseAt(id), c.rewardFunds(id), c.races(id)]);
    if (fullAt === 0n) continue;
    if (now < closeAt + grace) continue; // 下注窗口还没结束，继续等
    if (fund < (Number(r.currency) === 1 ? mgU : mg)) { log('场 #' + id + ' 满员但保证金不足，跳过'); done.add('o' + id); continue; }
    for (let a = 1; a <= 3; a++) {
      try {
        const tx = await w.sendTransaction({ to: RACE, data: c.interface.encodeFunctionData('timeStart', [id]), gasLimit: 4000000, gasPrice: GAS, chainId: 56 });
        log('场 #' + id + ' 下注窗口结束，已开赛 tx ' + tx.hash);
        done.add('o' + id);
        break;
      } catch (e) { log('场 #' + id + ' 开赛失败(' + a + ')：' + String(e.shortMessage || e.message).slice(0, 120)); await sleep(3000); }
    }
  }
}

async function tick() {
  await autoStart();
}

log('keeper 启动（只做满员自动开赛，60 秒巡查一次；结算与交割由前端所有人点，谁点谁付矿工费），地址 ' + w.address + '，运行 ' + RUN_MIN + ' 分钟');
const end = Date.now() + RUN_MIN * 60000;
while (Date.now() < end) {
  try { await tick(); } catch (e) { log('轮询异常：' + String(e.shortMessage || e.message).slice(0, 120)); }
  await sleep(POLL);
}
log('本轮结束，等待下一次调度');
