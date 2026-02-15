// SPDX-License-Identifier: BSD-4-Clause
pragma solidity ^0.8.23;

import "../ISccpVerifier.sol";

/// @notice Verifier that always fails. Use as a safe default to keep mints disabled.
contract AlwaysFalseVerifier is ISccpVerifier {
    function verifyBurnProof(
        uint32,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return false;
    }
}

