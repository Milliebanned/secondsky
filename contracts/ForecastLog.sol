// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ForecastLog: buys a Telegraph WEATHER_FORECAST_GENERAL answer for a SecondSky policy's place,
/// shortly before the covered day, and keeps Telegraph's answer on-chain next to the policy number.
/// Later the forecast is scored against the two recorded rainfall answers the policy settled on.
///
/// It holds a small balance of test USDC to pay for jobs (1 USDC each). The operator (the same hot key
/// that runs the SecondSky keeper) can only buy forecasts. The owner can change the operator and
/// withdraw the balance.

struct OnChainData {
    address[] addresses;
    uint256[] integers;
    string[] strings;
    bool[] bools;
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract ForecastLog {
    bytes32 public constant INTENT = keccak256("WEATHER_FORECAST_GENERAL");
    uint256 public constant BUDGET = 1_000_000; // 1 test USDC per forecast

    address public immutable diamond;
    IERC20 public immutable usdc;
    address public owner;
    address public operator;

    /// jobId => policy number it was bought for
    mapping(uint256 => uint256) public jobPolicy;
    /// jobId => packed answer: bit255 done, bit254 ok, bits 128..191 timestamp,
    ///          bits 64..127 low temp, bits 0..63 high temp (each the low 64 bits of Telegraph's value, °C × 1e6)
    mapping(uint256 => uint256) public answers;

    event Asked(uint256 indexed jobId, uint256 indexed policyId, string location, uint256 windowHours);
    event Answer(uint256 indexed jobId, bool ok);
    event Roles(address owner, address operator);

    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }

    constructor(address diamond_, address usdc_, address owner_, address operator_) {
        diamond = diamond_;
        usdc = IERC20(usdc_);
        owner = owner_;
        operator = operator_;
        emit Roles(owner_, operator_);
    }

    function ask(uint256 policyId, string calldata location, uint256 windowHours) external returns (uint256 jobId) {
        require(msg.sender == operator, "operator only");
        require(windowHours >= 1 && windowHours <= 240, "window 1-240 h");
        OnChainData memory params;
        params.addresses = new address[](0);
        params.integers = new uint256[](1);
        params.integers[0] = windowHours;
        params.strings = new string[](1);
        params.strings[0] = location;
        params.bools = new bool[](0);

        usdc.approve(diamond, BUDGET);
        (bool ok, bytes memory ret) = diamond.call(abi.encodeWithSignature(
            "createJobAndPay(bytes32,(address[],uint256[],string[],bool[]),address,uint256)",
            INTENT, params, address(this), BUDGET
        ));
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        require(ret.length >= 32, "no job id");
        jobId = abi.decode(ret, (uint256));
        usdc.approve(diamond, 0);
        jobPolicy[jobId] = policyId;
        emit Asked(jobId, policyId, location, windowHours);
    }

    /// Telegraph callback: one storage write.
    function subnetMessage(uint256 jobId, bool success, OnChainData calldata response, string calldata) external {
        require(msg.sender == diamond, "only protocol");
        bool ok = success && response.integers.length >= 2;
        uint256 hi = ok ? uint64(response.integers[0]) : 0;
        uint256 lo = ok ? uint64(response.integers[1]) : 0;
        answers[jobId] = (uint256(1) << 255) | (ok ? (uint256(1) << 254) : 0) | (uint256(uint64(block.timestamp)) << 128) | (lo << 64) | hi;
        emit Answer(jobId, ok);
    }

    function setRoles(address owner_, address operator_) external onlyOwner {
        require(owner_ != address(0), "zero owner");
        owner = owner_;
        operator = operator_;
        emit Roles(owner_, operator_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        require(usdc.transfer(to, amount), "transfer failed");
    }
}
