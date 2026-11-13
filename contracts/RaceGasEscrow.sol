// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice RaceSystem（赛事合约）最小接口：只读赛事状态
interface IRaceSystemView {
    // state（状态）取值：0=报名中 1=比赛中 2=已结束 3=已取消
    function races(uint256 raceId) external view returns (
        uint256 id,
        address organizer,
        uint8 currency,
        uint256 entryFee,
        uint8 state,
        uint256 startAt,
        uint256 endAt,
        uint256 pool,
        uint256 sponsor,
        uint8 raceType,
        uint64 startBlock
    );
}

/// @notice Betting（下注合约）最小接口：判断下注池是否已交割
interface IBettingView {
    function settled(uint256 raceId) external view returns (bool);
}

/// @title RaceGasEscrow 结算矿工费托管合约
/// @notice 谁开赛谁出结算费：社长建场时把一笔 BNB 预存进本合约（按赛事编号记账），
///         赛事结算并交割完成后，这笔钱自动赔付给结算钱包（keeper，云端自动结算用的钱包）。
///         预存的 BNB 只能走两条路：结算完成赔付给 keeper，或赛事取消退还给预存人；
///         合约所有者不能挪用，避免“钱进私人钱包”的信任问题。
contract RaceGasEscrow is Ownable {
    IRaceSystemView public immutable raceSystem;
    IBettingView public immutable betting;

    // 结算钱包：真正发结算交易、先垫矿工费的那个地址
    address public keeper;

    // 每场预存标准额（wei，1 BNB = 1e18 wei），默认 0.0005 BNB
    uint256 public feePerRace = 0.0005 ether;
    // 预存下限/上限：防止手滑存错金额
    uint256 public constant MIN_DEPOSIT = 0.0001 ether;
    uint256 public constant MAX_DEPOSIT = 0.01 ether;
    // 兜底期：无人下注时交割会失败，结束满 1 天后也允许结清，避免钱永远卡在合约里
    uint256 public constant CLAIM_FALLBACK = 1 days;

    struct Item {
        address payer;   // 预存人（社长）
        uint96 amount;   // 预存金额（wei）
    }
    // raceId（赛事编号）=> 预存记录
    mapping(uint256 => Item) public items;

    event Deposited(uint256 indexed raceId, address indexed payer, uint256 amount);
    event Claimed(uint256 indexed raceId, address indexed keeper, uint256 amount);
    event Refunded(uint256 indexed raceId, address indexed payer, uint256 amount);
    event KeeperSet(address indexed keeper);
    event FeeSet(uint256 fee);

    constructor(address raceSystem_, address betting_, address keeper_) Ownable(msg.sender) {
        require(raceSystem_ != address(0) && betting_ != address(0), "addr 0");
        require(keeper_ != address(0), "keeper 0");
        raceSystem = IRaceSystemView(raceSystem_);
        betting = IBettingView(betting_);
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice 更换结算钱包（所有者操作）
    function setKeeper(address k) external onlyOwner {
        require(k != address(0), "keeper 0");
        keeper = k;
        emit KeeperSet(k);
    }

    /// @notice 调整每场建议预存额（只影响之后的预存，已存的不变）
    function setFeePerRace(uint256 v) external onlyOwner {
        require(v >= MIN_DEPOSIT && v <= MAX_DEPOSIT, "bad fee");
        feePerRace = v;
        emit FeeSet(v);
    }

    /// @notice 建场时预存本场结算费；一场只能预存一次，金额在上下限之间
    function deposit(uint256 raceId) external payable {
        require(items[raceId].amount == 0, "exists");
        require(msg.value >= MIN_DEPOSIT && msg.value <= MAX_DEPOSIT, "bad amount");
        items[raceId] = Item(msg.sender, uint96(msg.value));
        emit Deposited(raceId, msg.sender, msg.value);
    }

    /// @notice 赛事结算完成后，任何人都能来催付，钱只打给 keeper
    ///         这样 keeper 不在线时别人也能把账结清，但谁也冒领不走
    function claim(uint256 raceId) external {
        Item memory it = items[raceId];
        require(it.amount > 0, "empty");
        (, , , , uint8 state, , uint256 endAt, , , , ) = raceSystem.races(raceId);
        require(state == 2, "not finished");       // 2 = 已结束
        // 正常等下注池交割完再催付；无人下注交割失败时，结束满 1 天也放行，避免卡死
        require(betting.settled(raceId) || block.timestamp >= endAt + CLAIM_FALLBACK, "pool open");
        delete items[raceId];
        (bool ok, ) = payable(keeper).call{value: it.amount}("");
        require(ok, "send fail");
        emit Claimed(raceId, keeper, it.amount);
    }

    /// @notice 赛事取消时，预存人取回本场预存费
    function refund(uint256 raceId) external {
        Item memory it = items[raceId];
        require(it.amount > 0, "empty");
        require(msg.sender == it.payer, "not payer");
        (, , , , uint8 state, , , , , , ) = raceSystem.races(raceId);
        require(state == 3, "not cancelled");      // 3 = 已取消
        delete items[raceId];
        (bool ok, ) = payable(it.payer).call{value: it.amount}("");
        require(ok, "send fail");
        emit Refunded(raceId, it.payer, it.amount);
    }

    /// @notice 这场是否已经可以催付（供前端显示按钮用）
    function claimable(uint256 raceId) external view returns (bool) {
        if (items[raceId].amount == 0) return false;
        (, , , , uint8 state, , uint256 endAt, , , , ) = raceSystem.races(raceId);
        return state == 2 && (betting.settled(raceId) || block.timestamp >= endAt + CLAIM_FALLBACK);
    }

    /// @notice 这场还压着多少预存费
    function balanceOfRace(uint256 raceId) external view returns (uint256) {
        return items[raceId].amount;
    }
}
