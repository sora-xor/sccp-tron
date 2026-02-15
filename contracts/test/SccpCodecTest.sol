// SPDX-License-Identifier: BSD-4-Clause
pragma solidity ^0.8.23;

import "../SccpCodec.sol";

/// @notice Test helper exposing SCCP codec functions for off-chain test runners.
contract SccpCodecTest {
    function encodeBurnPayloadV1(
        uint32 sourceDomain,
        uint32 destDomain,
        uint64 nonce,
        bytes32 soraAssetId,
        uint128 amount,
        bytes32 recipient
    ) external pure returns (bytes memory payload) {
        SccpCodec.BurnPayloadV1 memory p = SccpCodec.BurnPayloadV1({
            version: 1,
            sourceDomain: sourceDomain,
            destDomain: destDomain,
            nonce: nonce,
            soraAssetId: soraAssetId,
            amount: amount,
            recipient: recipient
        });
        payload = SccpCodec.encodeBurnPayloadV1(p);
    }

    function burnMessageId(bytes calldata payload) external pure returns (bytes32) {
        return SccpCodec.burnMessageId(payload);
    }

    function decodeBurnPayloadV1(bytes calldata payload)
        external
        pure
        returns (
            uint8 version,
            uint32 sourceDomain,
            uint32 destDomain,
            uint64 nonce,
            bytes32 soraAssetId,
            uint128 amount,
            bytes32 recipient
        )
    {
        SccpCodec.BurnPayloadV1 memory p = SccpCodec.decodeBurnPayloadV1(payload);
        return (p.version, p.sourceDomain, p.destDomain, p.nonce, p.soraAssetId, p.amount, p.recipient);
    }
}

