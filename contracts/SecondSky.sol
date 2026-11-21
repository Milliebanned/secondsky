// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// SecondSky: single-day rain cover that only pays when two independent rainfall sources agree.
///
/// Flow
///  1. The underwriter (an off-chain agent) prices a policy and signs a quote.
///  2. The holder calls buyCover with the quote and pays the premium in USDC. The payout is locked.
///  3. After the covered day, anyone calls settle(). The contract itself buys the day's recorded
///     rainfall from Telegraph twice, from two named miners (ERC-8183 createJobForMiner).
///  4. Telegraph calls back with each answer. The callback does ONE storage write (gas is limited).
///  5. Anyone calls finalize():
///       both sources say rain >= threshold  -> pay the holder
///       both say rain <  threshold          -> no payout, policy closed
///       they disagree                       -> Disputed: no automatic payout, human review
///       a job failed                        -> back to Active, settle() can be retried
///  6. If a policy can't be settled within the grace period, the holder gets the premium back.
///
/// Known limit (documented, not hidden): Telegraph may route a job to a fallback miner if the
/// named one does not answer, and the resolving miner is not readable on-chain. The keeper can
/// therefore mark a policy Disputed after checking the job receipts. It can only BLOCK an automatic
/// payout, never force one.

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

interface IDiamondJobs {
    function getJobBasePrice() external view returns (uint256);
}

contract SecondSky {
    // ---- configuration ----
    address public immutable diamond;
    IERC20 public immutable usdc;
    bytes32 public constant INTENT = keccak256("WEATHER_FORECAST_VERIFY_GENERAL");
    uint256 public constant RAIN_INDEX = 2;            // response.integers[2] = precipitation_mm x 1e6
    uint256 public constant SETTLE_GRACE = 7 days;     // after this, an unsettled policy can be refunded

    address public owner;      // underwriter + keeper
    uint256 public sourceA;    // miner registration id, e.g. an Open-Meteo based miner
    uint256 public sourceB;    // miner registration id, an independent source
    uint256 public maxJobBudget; // cap per Telegraph job, USDC 6 decimals

    // ---- policies ----
    enum Status { None, Active, Settling, Paid, NotPaid, Disputed, Refunded }

    struct Policy {
        address holder;
        uint96 payout;        // USDC, 6 decimals
        uint96 premium;       // USDC, 6 decimals
        uint96 jobReserve;    // USDC set aside for the two evidence purchases, released at settle
        uint64 settleAfter;   // unix time after the covered day has ended
        uint64 thresholdE6;   // rain limit in mm x 1e6; pay if rain >= limit
        Status status;
        uint64 jobA;
        uint64 jobB;
        string location;
        string date;          // YYYY-MM-DD
    }

    mapping(uint256 => Policy) public policies;
    uint256 public policyCount;
    uint256 public lockedPayouts;          // payouts promised to active policies
    mapping(bytes32 => bool) public usedQuotes;

    // job id => policyId (set when the job is created, never in the callback)
    mapping(uint256 => uint256) public jobPolicy;
    // job id => packed answer: bit 255 = done, bit 254 = ok, low 64 bits = rain mm x 1e6
    mapping(uint256 => uint256) public answers;

    // ---- events ----
    event CoverBought(uint256 indexed policyId, address indexed holder, string location, string date, uint256 thresholdE6, uint256 payout, uint256 premium);
    event SettleRequested(uint256 indexed policyId, uint256 jobA, uint256 jobB);
    event Answer(uint256 indexed jobId, bool ok, uint256 rainE6, string reason);
    event Finalized(uint256 indexed policyId, Status status, uint256 rainA, uint256 rainB);
    event Retry(uint256 indexed policyId, bool okA, bool okB);
    event Refunded(uint256 indexed policyId, uint256 amount);
    event DisputeResolved(uint256 indexed policyId, bool paid);

    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }

    constructor(address diamond_, address usdc_, uint256 sourceA_, uint256 sourceB_, uint256 maxJobBudget_) {
        require(sourceA_ != sourceB_, "sources must differ");
        diamond = diamond_;
        usdc = IERC20(usdc_);
        owner = msg.sender;
        sourceA = sourceA_;
        sourceB = sourceB_;
        maxJobBudget = maxJobBudget_;
    }

    // ---------------------------------------------------------------- admin

    function setSources(uint256 a, uint256 b) external onlyOwner {
        require(a != b, "sources must differ");
        sourceA = a;
        sourceB = b;
    }

    function setMaxJobBudget(uint256 v) external onlyOwner { maxJobBudget = v; }

    function transferOwnership(address n) external onlyOwner { owner = n; }

    /// Free capital = balance not promised to policies. The underwriter can withdraw only that.
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
        bytes32 h = quoteHash(msg.sender, location, date, settleAfter, thresholdE6, payout, premium, quoteExpiry);
        require(!usedQuotes[h], "quote used");
        require(_recover(_ethSigned(h), sig) == owner, "bad quote signature");
        usedQuotes[h] = true;

        require(usdc.transferFrom(msg.sender, address(this), premium), "premium transfer failed");
        // the pool must be able to cover the payout plus the two evidence purchases
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

    /// Anyone can trigger settlement once the covered day is over. The contract pays for the evidence.
    function settle(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Active, "not active");
        require(block.timestamp >= p.settleAfter, "too early");
        if (p.jobReserve > 0) {
            lockedPayouts -= p.jobReserve; // first attempt: spend the reserve set aside at purchase
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
        answers[jobId] = (uint256(1) << 255) | (ok ? (uint256(1) << 254) : 0) | rain;
        emit Answer(jobId, ok, rain, errorMessage);
    }

    /// Anyone can finalize once both answers are in.
    function finalize(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.status == Status.Settling, "not settling");
        (bool doneA, bool okA, uint256 rainA) = _unpack(answers[p.jobA]);
        (bool doneB, bool okB, uint256 rainB) = _unpack(answers[p.jobB]);
        require(doneA && doneB, "waiting for answers");

        if (!okA || !okB) {
            p.status = Status.Active; // a source failed: allow a retry (the protocol refunds failed jobs)
            emit Retry(policyId, okA, okB);
            return;
        }

        bool wetA = rainA >= p.thresholdE6;
        bool wetB = rainB >= p.thresholdE6;
        if (wetA && wetB) {
            _pay(p);
            p.status = Status.Paid;
        } else if (!wetA && !wetB) {
            lockedPayouts -= p.payout;
            p.status = Status.NotPaid;
        } else {
            p.status = Status.Disputed; // the two skies disagree: never pay automatically
        }
        emit Finalized(policyId, p.status, rainA, rainB);
    }

    /// Keeper: after checking the job receipts off-chain, block an automatic payout
    /// (e.g. a job fell back to a miner on the same upstream source). Cannot force a payout.
    function flagDispute(uint256 policyId) external onlyOwner {
        Policy storage p = policies[policyId];
        require(p.status == Status.Settling, "not settling");
        p.status = Status.Disputed;
        emit Finalized(policyId, Status.Disputed, 0, 0);
    }

    /// Human review of a disputed policy.
    function resolveDispute(uint256 policyId, bool pay) external onlyOwner {
        Policy storage p = policies[policyId];
        require(p.status == Status.Disputed, "not disputed");
        if (pay) {
            _pay(p);
            p.status = Status.Paid;
        } else {
            lockedPayouts -= p.payout;
            p.status = Status.NotPaid;
        }
        emit DisputeResolved(policyId, pay);
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

    /// Owner-only pass-through to the Diamond, e.g. to withdraw refunds of failed jobs from this
    /// contract's escrow there. USDC allowance to the Diamond is always reset to 0 after settle().
    function execDiamond(bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = diamond.call(data);
        if (!ok) _bubble(ret);
        return ret;
    }

    // ---------------------------------------------------------------- views

    function getPolicy(uint256 id) external view returns (Policy memory) { return policies[id]; }

    function answerOf(uint256 jobId) external view returns (bool done, bool ok, uint256 rainE6) {
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

    function _pay(Policy storage p) internal {
        lockedPayouts -= p.payout;
        require(usdc.transfer(p.holder, p.payout), "payout failed");
    }

    function _unpack(uint256 v) internal pure returns (bool done, bool ok, uint256 rain) {
        done = (v >> 255) & 1 == 1;
        ok = (v >> 254) & 1 == 1;
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
