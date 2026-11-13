// 云端 keeper：满员自动开赛 + 到点自动结算 + 自动交割下注池
// 环境变量：KEEPER_PK（必填，仅含 BNB 的 keeper 钱包私钥）、RPC_URL（可选）
// 自动结算是为了避免社长不点按钮时赛事永久停在 Racing：任何地址都可调 finishRace，
// 交割下注池 settle 同样任何人可调且只执行一次，因此 keeper 可以全自动收尾。
import { ethers } from 'ethers';

const RACE = '0x8F5a241BaD21e63d4a4553BA675CdE76363b5149';
const BET = '0x50358dF97F8129E4C3583149d634312c427A75ED';
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const PK = process.env.KEEPER_PK;
const POLL = 60000;       // 开赛巡查间隔：满员后最多晚 1 分钟开跑；结算不走这个频率
const RUN_MIN = Number(process.env.RUN_MIN || 340);
const SCAN = 10;          // 自动开赛扫描最近多少场
const SETTLE_SCAN = 30;   // 自动结算扫描最近多少场
const SETTLE_AFTER = 86400; // 结束满 24 小时仍未结算才自动接管，给社长留足手动结算时间

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
  'function finishRace(uint256)',
];

const BET_ABI = [
  'function settled(uint256) view returns(bool)',
  'function settle(uint256)',
];

if (!PK) { console.error('缺少 KEEPER_PK'); process.exit(1); }

const p = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true, batchMaxCount: 10, timeout: 20000 });
const c = new ethers.Contract(RACE, ABI, p);
const bet = new ethers.Contract(BET, BET_ABI, p);
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

/* 到点自动结算：state 1 且已过 endAt + 24 小时 → finishRace（任何人可调）
   结算完再交割下注池：state 2 且未 settled → Betting.settle（产生冠军、开启领奖窗口）
   注意：本函数每轮任务只在启动时巡查一次，不参与 15 秒轮询，避免频繁扫链 */
async function autoSettle() {
  const count = Number(await c.raceCount());
  const ids = [];
  for (let id = Math.max(1, count - SETTLE_SCAN + 1); id <= count; id++) ids.push(id);
  const rs = await Promise.all(ids.map(id => c.races(id).catch(() => null)));
  const now = BigInt((await p.getBlock('latest')).timestamp);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const r = rs[i];
    if (!r) continue;
    const st = Number(r.state);

    if (st === 1 && !done.has('f' + id)) {
      if (r.endAt === 0n || now < r.endAt + BigInt(SETTLE_AFTER)) continue;
      for (let a = 1; a <= 3; a++) {
        try {
          const tx = await w.sendTransaction({ to: RACE, data: c.interface.encodeFunctionData('finishRace', [id]), gasLimit: 1800000, gasPrice: GAS, chainId: 56 });
          log('场 #' + id + ' 已到点，自动结算出名次 tx ' + tx.hash);
          done.add('f' + id);
          break;
        } catch (e) {
          log('场 #' + id + ' 自动结算失败(' + a + ')：' + String(e.shortMessage || e.message).slice(0, 120));
          await sleep(3000);
        }
      }
      continue;
    }

    if (st === 2 && !done.has('s' + id)) {
      try {
        if (await bet.settled(id)) { done.add('s' + id); continue; }
        const tx = await w.sendTransaction({ to: BET, data: bet.interface.encodeFunctionData('settle', [id]), gasLimit: 1500000, gasPrice: GAS, chainId: 56 });
        log('场 #' + id + ' 已出结果，自动交割下注池 tx ' + tx.hash);
        done.add('s' + id);
      } catch (e) {
        log('场 #' + id + ' 交割下注池失败：' + String(e.shortMessage || e.message).slice(0, 120));
        done.add('s' + id); // 防止每轮重复重试（如本场无人下注）
      }
    }
  }
}

let settleChecked = false;
async function tick() {
  await autoStart();
  // 结算巡查每轮任务只做一次：结束满 24 小时的场次才动手，不需要 15 秒扫
  if (!settleChecked) { settleChecked = true; await autoSettle(); }
}

log('keeper 启动（自动开赛 15 秒轮询 + 结算每轮巡查一次/结束满 24 小时接管），地址 ' + w.address + '，运行 ' + RUN_MIN + ' 分钟');
const end = Date.now() + RUN_MIN * 60000;
while (Date.now() < end) {
  try { await tick(); } catch (e) { log('轮询异常：' + String(e.shortMessage || e.message).slice(0, 120)); }
  await sleep(POLL);
}
log('本轮结束，等待下一次调度');
