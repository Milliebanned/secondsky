// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Kill test 3 for RainCover: a contract that buys past rainfall from Telegraph by itself
// (ERC-8183 on-chain job, paid from its own USDC) and stores the answer from the callback.

struct OnChainData {
    address[] addresses;
    uint256[] integers;
    string[] strings;
    bool[] bools;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract RainProbe {
    address public constant DIAMOND = 0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b;
    address public constant USDC = 0xcc194e1a843B658526D0D5C431f670028582Ae17;
    bytes32 public constant INTENT = keccak256("WEATHER_FORECAST_VERIFY_GENERAL");

    address public immutable owner;

    // Packed into ONE storage slot: new-slot writes cost ~100k gas here and the callback's
    // gas is limited, so the callback must stay to a single write (5 slots ran out of gas).
    struct Reading {
        int64 tempMaxE6;    // °C x 10^6
        int64 tempMinE6;    // °C x 10^6
        uint64 rainE6;      // mm x 10^6
        bool done;
        bool ok;
    }

    mapping(uint256 => Reading) public readings;
    uint256 public lastJobId;

    event Requested(string location, string date, uint256 maxBudget, bytes returnData);
    event Answered(uint256 indexed jobId, bool ok, uint256 rainE6, string reason);

    constructor() { owner = msg.sender; }

    // The contract itself pays: it approves the Diamond and calls createJobAndPay.
    function request(string calldata location, string calldata date, uint256 maxBudget) external {
        require(msg.sender == owner, "owner only");
        IERC20(USDC).approve(DIAMOND, maxBudget);

        OnChainData memory params;
        params.addresses = new address[](0);
        params.integers = new uint256[](0);
        params.bools = new bool[](0);
        params.strings = new string[](2);
        params.strings[0] = location;
        params.strings[1] = date;

        (bool ok, bytes memory ret) = DIAMOND.call(
            abi.encodeWithSignature(
                "createJobAndPay(bytes32,(address[],uint256[],string[],bool[]),address,uint256)",
                INTENT, params, address(this), maxBudget
            )
        );
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) } // bubble up the protocol's revert reason
        }
        if (ret.length >= 32) lastJobId = abi.decode(ret, (uint256));
        emit Requested(location, date, maxBudget, ret);
    }

    // Telegraph's callback. Layout for WEATHER_FORECAST_VERIFY: integers[0]=temp_max, [1]=temp_min, [2]=precipitation (x10^6).
    function subnetMessage(uint256 jobId, bool success, OnChainData calldata response, string calldata errorMessage) external {
        require(msg.sender == DIAMOND, "only protocol");
        Reading memory r;
        r.done = true;
        r.ok = success;
        if (success) {
            uint256[] calldata v = response.integers;
            if (v.length > 0) r.tempMaxE6 = int64(int256(v[0]));
            if (v.length > 1) r.tempMinE6 = int64(int256(v[1]));
            if (v.length > 2) r.rainE6 = uint64(v[2]);
        }
        readings[jobId] = r; // single SSTORE
        emit Answered(jobId, success, r.rainE6, errorMessage); // error text goes in the event, not storage
    }

    // If no answer arrives, the buyer (this contract) can cancel after the protocol's delay and get refunded.
    function cancel(uint256 jobId) external {
        require(msg.sender == owner, "owner only");
        (bool ok, bytes memory ret) = DIAMOND.call(abi.encodeWithSignature("cancelJob(uint256)", jobId));
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function withdraw() external {
        require(msg.sender == owner, "owner only");
        IERC20(USDC).transfer(owner, IERC20(USDC).balanceOf(address(this)));
    }
}
