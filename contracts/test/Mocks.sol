// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test doubles: a mintable USDC and a Diamond that behaves like Telegraph's job flow
// (pulls the price with transferFrom, assigns job ids, calls back with a gas stipend, swallows reverts).

struct OnChainData {
    address[] addresses;
    uint256[] integers;
    string[] strings;
    bool[] bools;
}

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        allowance[f][msg.sender] -= a;
        _move(f, t, a);
        return true;
    }
    function _move(address f, address t, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[t] += a; }
}

interface ICallback {
    function subnetMessage(uint256 jobId, bool success, OnChainData calldata response, string calldata errorMessage) external;
}

contract MockDiamond {
    MockUSDC public usdc;
    uint256 public price = 1_000_000;
    uint256 public jobCount;
    uint256 public callbackGas = 1_000_000;
    struct Job { address agent; address callback; uint256 miner; string location; string date; bool resolved; }
    mapping(uint256 => Job) public jobs;
    bool public lastCallbackOk;

    constructor(MockUSDC u) { usdc = u; }

    function getJobBasePrice() external view returns (uint256) { return price; }

    function createJobForMiner(bytes32, uint256 miner, OnChainData calldata params, address callback, uint256 maxBudget, bool) external returns (uint256 id) {
        require(price <= maxBudget, "job price above maxBudget");
        require(usdc.transferFrom(msg.sender, address(this), price), "pay");
        id = ++jobCount;
        jobs[id] = Job(msg.sender, callback, miner, params.strings[0], params.strings[1], false);
    }

    function cancelJob(uint256 id) external {
        require(jobs[id].agent == msg.sender, "not agent");
        require(!jobs[id].resolved, "resolved");
        jobs[id].resolved = true;
        usdc.transfer(msg.sender, price);
    }

    // test hook: resolve a job like the validator quorum would
    function resolve(uint256 id, bool success, uint256 rainE6) external {
        Job storage j = jobs[id];
        require(!j.resolved, "resolved");
        j.resolved = true;
        OnChainData memory r;
        r.addresses = new address[](0);
        r.strings = new string[](0);
        r.bools = new bool[](0);
        if (success) {
            r.integers = new uint256[](3);
            r.integers[0] = 24_300_000;
            r.integers[1] = 15_900_000;
            r.integers[2] = rainE6;
        } else {
            r.integers = new uint256[](0);
        }
        try ICallback(j.callback).subnetMessage{gas: callbackGas}(id, success, r, success ? "" : "no miner answered") {
            lastCallbackOk = true;
        } catch {
            lastCallbackOk = false;
        }
    }
}
