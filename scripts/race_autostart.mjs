// 云端 keeper：满员自动开赛 + 开赛满 10 分钟自动结算（名次 + 交割下注池）。
// 结算谁先点都行，前端也保留手动按钮；keeper 兜底保证到点必结算，不用等人。
// 环境变量：KEEPER_PK（必填，仅含 BNB 的 keeper 钱包私钥）、RPC_URL（可选）
import { ethers } from 'ethers';

const RACE = '0x8F5a241BaD21e63d4a4553BA675CdE76363b5149';
const BET = '0x50358dF97F8129E4C3583149d634312c427A75ED';
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const PK = process.env.KEEPER_PK;
const POLL = 60000;       // 巡查间隔：开赛与结算都走这个频率，到点最多晚 1 分钟动手
const RUN_MIN = Number(process.env.RUN_MIN || 340);
const SCAN = 10;          // 自动开赛扫描最近多少场
const SETTLE_SCAN = 5;    // 自动结算扫描最近多少场（只处理刚结束的，省 RPC）

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

/* 到点自动结算：开赛满 10 分钟（endAt）立即结算名次，紧接着交割下注池。
   两步都是公开函数，keeper 只是当第一个动手的人，保证不用等社长/玩家。 */
async function autoSettle() {
  const count = Number(await c.raceCount());
  const now = BigInt((await p.getBlock('latest')).timestamp);
  const ids = [];
  for (let id = Math.max(1, count - SETTLE_SCAN + 1); id <= count; id++) ids.push(id);

  for (const id of ids) {
    if (done.has('s' + id)) continue;
    let r = await c.races(id).catch(() => null);
    if (!r) continue;

    // 第一步：名次
    if (Number(r.state) === 1 && !done.has('f' + id)) {
      if (r.endAt === 0n || now < r.endAt) continue;
      try {
        const tx = await w.sendTransaction({ to: RACE, data: c.interface.encodeFunctionData('finishRace', [id]), gasLimit: 4000000, gasPrice: GAS, chainId: 56 });
        log('场 #' + id + ' 开赛满 10 分钟，自动结算名次 tx ' + tx.hash);
        await tx.wait(1);
        done.add('f' + id);
      } catch (e) {
        log('场 #' + id + ' 自动结算失败：' + String(e.shortMessage || e.message).slice(0, 120));
        // 多半是别人抢先从页面结算了：状态已变就不再重试
        const r2 = await c.races(id).catch(() => null);
        if (r2 && Number(r2.state) !== 1) done.add('f' + id);
        continue;
      }
      r = await c.races(id).catch(() => null);
      if (!r) continue;
    }

    // 第二步：交割下注池（产生冠军、开启领奖窗口）
    if (Number(r.state) === 2) {
      try {
        if (await bet.settled(id)) { done.add('s' + id); continue; }
        const tx = await w.sendTransaction({ to: BET, data: bet.interface.encodeFunctionData('settle', [id]), gasLimit: 2500000, gasPrice: GAS, chainId: 56 });
        log('场 #' + id + ' 已出名次，自动交割下注池 tx ' + tx.hash);
        done.add('s' + id);
      } catch (e) {
        log('场 #' + id + ' 交割下注池失败：' + String(e.shortMessage || e.message).slice(0, 120));
        done.add('s' + id); // 如本场无人下注会 revert，标记后不反复重试；下一轮任务仍会重新尝试
      }
    }
  }
}

async function tick() {
  await autoStart();
  await autoSettle();
}

log('keeper 启动（满员自动开赛 + 开赛满 10 分钟自动结算，60 秒巡查一次），地址 ' + w.address + '，运行 ' + RUN_MIN + ' 分钟');
const end = Date.now() + RUN_MIN * 60000;
while (Date.now() < end) {
  try { await tick(); } catch (e) { log('轮询异常：' + String(e.shortMessage || e.message).slice(0, 120)); }
  await sleep(POLL);
}
log('本轮结束，等待下一次调度');
