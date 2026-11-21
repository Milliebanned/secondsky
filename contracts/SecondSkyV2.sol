// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// SecondSky v2: single-day rain cover settled from two independent rainfall sources,
/// with no human in the claim decision.
///
/// Flow
///  1. The operator (a hot key run by the quote service) prices a policy and signs a quote.
///  2. The holder calls buyCover with the quote and pays the premium in USDC. Payout + evidence budget are locked.
///  3. After the covered day, anyone calls settle(). The contract buys the day's recorded rainfall
///     from Telegraph twice, from two named miners (ERC-8183 createJobForMiner).
///  4. Telegraph calls back with each answer. The callback does ONE storage write (gas is limited).
///  5. finalize():
///       both sources: rain >= limit   -> pay 100%
///       sources split                 -> pay 50%   (measured basis risk, priced into the premium)
///       both sources: rain <  limit   -> pay 0
///       a job failed                  -> back to Active, settle() can be retried
///     The operator can finalize at once. Anyone else can finalize FINALIZE_DELAY after the last
///     answer, which leaves the operator time to check Telegraph's job records.
///  6. If Telegraph's record shows a job was answered by a miner other than the one named
///     (fallback routing), the operator sends the policy back to Active for a fresh purchase.
///     It cannot choose an outcome or force a payout.
///  7. If a policy can't be settled within the grace period, the holder gets the premium back.
///
/// Roles: owner = cold key (money, sources, operator). operator = hot key (quotes, keeper).
/// A leaked operator key can sign quotes only up to maxPayout and only against free capital.

struct OnChainData {
    address[] addresses;
    uint256[] integers;
    string[] strings;
    bool[] bools;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract SecondSkyV2 {
    // ---- configuration ----
    address public immutable diamond;
    IERC20 public immutable usdc;
    bytes32 public constant INTENT = keccak256("WEATHER_FORECAST_VERIFY_GENERAL");
    uint256 public constant RAIN_INDEX = 2;            // response.integers[2] = precipitation_mm x 1e6
    uint256 public constant SETTLE_GRACE = 7 days;     // after this, an unsettled policy can be refunded
    uint256 public constant FINALIZE_DELAY = 1 days;   // public finalize waits this long after the last answer

    address public owner;        // cold: capital, sources, roles
    address public operator;     // hot: signs quotes, runs the keeper
    uint256 public sourceA;      // miner registration id (Open-Meteo based)
    uint256 public sourceB;      // miner registration id (independent upstream)
    uint256 public maxJobBudget; // cap per Telegraph job, USDC 6 decimals
    uint256 public maxPayout;    // cap per policy, bounds what a quote can promise

    enum Status { None, Active, Settling, Paid, PaidHalf, NotPaid, Refunded }

    struct Policy {
        address holder;
        uint96 payout;        // USDC, 6 decimals
        uint96 premium;       // USDC, 6 decimals
        uint96 jobReserve;    // USDC set aside for the two evidence purchases, released at settle
        uint64 settleAfter;   // unix time after which settle() may run
        uint64 thresholdE6;   // rain limit in mm x 1e6
        Status status;
        uint64 jobA;
        uint64 jobB;
        string location;      // sent verbatim to both miners, e.g. "6.4541,3.3947"
        string date;          // YYYY-MM-DD
    }

    mapping(uint256 => Policy) public policies;
    uint256 public policyCount;
    uint256 public lockedPayouts;          // payouts + evidence budgets promised to open policies
    mapping(bytes32 => bool) public usedQuotes;
    mapping(uint256 => uint256) public jobPolicy;
    // job id => packed answer: bit 255 done, bit 254 ok, bits 64..127 answer time, bits 0..63 rain mm x 1e6
    mapping(uint256 => uint256) public answers;

    event CoverBought(uint256 indexed policyId, address indexed holder, string location, string date, uint256 thresholdE6, uint256 payout, uint256 premium);
    event SettleRequested(uint256 indexed policyId, uint256 jobA, uint256 jobB);
    event Answer(uint256 indexed jobId, bool ok, uint256 rainE6, string reason);
    event Finalized(uint256 indexed policyId, Status status, uint256 rainA, uint256 rainB, uint256 paid);
    event Retry(uint256 indexed policyId, bool okA, bool okB);
    event WrongMiner(uint256 indexed policyId, uint256 jobId);
    event Refunded(uint256 indexed policyId, uint256 amount);
    event RolesChanged(address owner, address operator);

    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }
    modifier onlyOperator() { require(msg.sender == operator, "operator only"); _; }

    constructor(address diamond_, address usdc_, uint256 sourceA_, uint256 sourceB_, uint256 maxJobBudget_, uint256 maxPayout_, address operator_) {
        require(sourceA_ != sourceB_, "sources must differ");
        diamond = diamond_;
        usdc = IERC20(usdc_);
        owner = msg.sender;
        operator = operator_;
        sourceA = sourceA_;
        sourceB = sourceB_;
        maxJobBudget = maxJobBudget_;
        maxPayout = maxPayout_;
        emit RolesChanged(msg.sender, operator_);
    }

    // ---------------------------------------------------------------- admin (cold key)

    function setSources(uint256 a, uint256 b) external onlyOwner {
        require(a != b, "sources must differ");
        sourceA = a;
        sourceB = b;
    }
    function setMaxJobBudget(uint256 v) external onlyOwner { maxJobBudget = v; }
    function setMaxPayout(uint256 v) external onlyOwner { maxPayout = v; }
    function setOperator(address o) external onlyOwner { operator = o; emit RolesChanged(owner, o); }
    function transferOwnership(address n) external onlyOwner { owner = n; emit RolesChanged(n, operator); }

    /// Free capital = balance not promised to policies. Only this can be withdrawn.
    function freeCapital() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > lockedPayouts ? bal - lockedPayouts : 0;
    }
    function withdrawFree(uint256 amount) external onlyOwner {
        require(amount <= freeCapital(), "exceeds free capital");
        require(usdc.transfer(owner, amount), "transfer failed");
    }

    // ---------------------------------------------------------------- buying cover

    function quoteHash(
        address holder, string calldata location, string calldata date, uint64 settleAfter,
        uint64 thresholdE6, uint96 payout, uint96 premium, uint64 quoteExpiry
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(this), holder, keccak256(bytes(location)), keccak256(bytes(date)),
            settleAfter, thresholdE6, payout, premium, quoteExpiry
        ));
    }

    function buyCover(
        string calldata location, string calldata date, uint64 settleAfter, uint64 thresholdE6,
        uint96 payout, uint96 premium, uint64 quoteExpiry, bytes calldata sig
    ) external returns (uint256 policyId) {
        require(block.timestamp <= quoteExpiry, "quote expired");
        require(payout > 0 && premium > 0, "bad amounts");
        require(payout <= maxPayout, "payout above cap");
        bytes32 h = quoteHash(msg.sender, location, date, settleAfter, thresholdE6, payout, premium, quoteExpiry);
        require(!usedQuotes[h], "quote used");
        require(_recover(_ethSigned(h), sig) == operator, "bad quote signature");
        usedQuotes[h] = true;

        require(usdc.transferFrom(msg.sender, address(this), premium), "premium transfer failed");
        uint256 reserve = 2 * maxJobBudget;
        require(freeCapital() >= uint256(payout) + reserve, "pool too small");
        lockedPayouts += uint256(payout) + reserve;

        policyId = ++policyCount;
        Policy storage p = policies[policyId];
        p.holder = msg.sender;
        p.payout = payout;
        p.premium = premium;
        p.jobReserve = uint96(reserve);
        p.settleAfter = settleAfter;
        p.thresholdE6 = thresholdE6;
        p.status = Status.Active;
        p.location = location;
        p.date = date;
        emit CoverBought(policyId, msg.sender, location, date, thresholdE6, payout, premium);
    }

    // ---------------------------------------------------------------- settlement

    /// Anyone can trigger settlement once allowed. The contract pays for the evidence.
    function settle(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Active, "not active");
        require(block.timestamp >= p.settleAfter, "too early");
        if (p.jobReserve > 0) {
            lockedPayouts -= p.jobReserve;
            p.jobReserve = 0;
        } else {
            require(freeCapital() >= 2 * maxJobBudget, "pool cannot fund a retry");
        }

        OnChainData memory params;
        params.addresses = new address[](0);
        params.integers = new uint256[](0);
        params.bools = new bool[](0);
        params.strings = new string[](2);
        params.strings[0] = p.location;
        params.strings[1] = p.date;

        usdc.approve(diamond, 2 * maxJobBudget);
        uint256 a = _createJobForMiner(sourceA, params);
        uint256 b = _createJobForMiner(sourceB, params);
        usdc.approve(diamond, 0);

        jobPolicy[a] = policyId;
        jobPolicy[b] = policyId;
        p.jobA = uint64(a);
        p.jobB = uint64(b);
        p.status = Status.Settling;
        emit SettleRequested(policyId, a, b);
    }

    /// Telegraph callback. Exactly one storage write: the callback's gas is limited.
    function subnetMessage(uint256 jobId, bool success, OnChainData calldata response, string calldata errorMessage) external {
        require(msg.sender == diamond, "only protocol");
        uint256 rain;
        bool ok = success && response.integers.length > RAIN_INDEX;
        if (ok) {
            rain = response.integers[RAIN_INDEX];
            if (rain > type(uint64).max) { ok = false; rain = 0; }
        }
        answers[jobId] = (uint256(1) << 255) | (ok ? (uint256(1) << 254) : 0) | (uint256(uint64(block.timestamp)) << 64) | rain;
        emit Answer(jobId, ok, rain, errorMessage);
    }

    function finalize(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Settling, "not settling");
        (bool doneA, bool okA, uint256 tA, uint256 rainA) = _unpack(answers[p.jobA]);
        (bool doneB, bool okB, uint256 tB, uint256 rainB) = _unpack(answers[p.jobB]);
        require(doneA && doneB, "waiting for answers");
        if (msg.sender != operator) {
            require(block.timestamp >= (tA > tB ? tA : tB) + FINALIZE_DELAY, "operator check window");
        }

        if (!okA || !okB) {
            p.status = Status.Active; // a source failed: retry (Telegraph refunds failed jobs to this contract)
            emit Retry(policyId, okA, okB);
            return;
        }

        bool wetA = rainA >= p.thresholdE6;
        bool wetB = rainB >= p.thresholdE6;
        uint256 paid;
        if (wetA && wetB) {
            paid = p.payout;
            p.status = Status.Paid;
        } else if (wetA || wetB) {
            paid = uint256(p.payout) / 2;
            p.status = Status.PaidHalf;
        } else {
            p.status = Status.NotPaid;
        }
        lockedPayouts -= p.payout;
        if (paid > 0) require(usdc.transfer(p.holder, paid), "payout failed");
        emit Finalized(policyId, p.status, rainA, rainB, paid);
    }

    /// Operator: Telegraph's job record shows a miner other than the named one answered.
    /// The policy goes back to Active and is settled again. No outcome can be chosen here.
    function rejectWrongMiner(uint256 policyId, uint256 jobId) external onlyOperator {
        Policy storage p = policies[policyId];
        require(p.status == Status.Settling, "not settling");
        require(jobId == p.jobA || jobId == p.jobB, "not this policy's job");
        p.status = Status.Active;
        emit WrongMiner(policyId, jobId);
    }

    /// If a policy could not be settled within the grace period, the holder gets the premium back.
    function refund(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Active || p.status == Status.Settling, "not refundable");
        require(block.timestamp >= uint256(p.settleAfter) + SETTLE_GRACE, "grace period not over");
        lockedPayouts -= uint256(p.payout) + p.jobReserve;
        p.jobReserve = 0;
        p.status = Status.Refunded;
        require(usdc.transfer(p.holder, p.premium), "refund failed");
        emit Refunded(policyId, p.premium);
    }

    /// Cancel a Telegraph job that never resolved (only the agent, i.e. this contract, may cancel).
    function cancelStuckJob(uint256 jobId) external onlyOwner {
        (bool ok, bytes memory ret) = diamond.call(abi.encodeWithSignature("cancelJob(uint256)", jobId));
        if (!ok) _bubble(ret);
    }

    /// Owner pass-through to the Diamond, e.g. to withdraw refunds of failed jobs held there for this contract.
    function execDiamond(bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = diamond.call(data);
        if (!ok) _bubble(ret);
        return ret;
    }

    // ---------------------------------------------------------------- views

    function getPolicy(uint256 id) external view returns (Policy memory) { return policies[id]; }

    function answerOf(uint256 jobId) external view returns (bool done, bool ok, uint256 answeredAt, uint256 rainE6) {
        return _unpack(answers[jobId]);
    }

    // ---------------------------------------------------------------- internals

    function _createJobForMiner(uint256 minerId, OnChainData memory params) internal returns (uint256 jobId) {
        (bool ok, bytes memory ret) = diamond.call(abi.encodeWithSignature(
            "createJobForMiner(bytes32,uint256,(address[],uint256[],string[],bool[]),address,uint256,bool)",
            INTENT, minerId, params, address(this), maxJobBudget, true
        ));
        if (!ok) _bubble(ret);
        require(ret.length >= 32, "no job id");
        jobId = abi.decode(ret, (uint256));
    }

    function _unpack(uint256 v) internal pure returns (bool done, bool ok, uint256 t, uint256 rain) {
        done = (v >> 255) & 1 == 1;
        ok = (v >> 254) & 1 == 1;
        t = (v >> 64) & type(uint64).max;
        rain = v & type(uint64).max;
    }

    function _ethSigned(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "bad sig");
        return a;
    }

    function _bubble(bytes memory ret) internal pure {
        assembly { revert(add(ret, 32), mload(ret)) }
    }
}
