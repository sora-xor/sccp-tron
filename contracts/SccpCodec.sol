// SPDX-License-Identifier: BSD-4-Clause
pragma solidity ^0.8.23;

/// @notice SCALE codec helpers for SCCP burn payloads.
///
/// SCCP message id on all chains is:
/// `keccak256(b"sccp:burn:v1" || SCALE(BurnPayloadV1))`.
library SccpCodec {
    bytes internal constant SCCP_MSG_PREFIX_BURN_V1 = "sccp:burn:v1";
    uint256 internal constant BURN_PAYLOAD_V1_LEN = 97;

    error InvalidPayloadLength(uint256 len);

    struct BurnPayloadV1 {
        uint8 version;
        uint32 sourceDomain;
        uint32 destDomain;
        uint64 nonce;
        bytes32 soraAssetId;
        uint128 amount;
        bytes32 recipient;
    }

    function burnMessageId(bytes memory payload) internal pure returns (bytes32) {
        return keccak256(bytes.concat(SCCP_MSG_PREFIX_BURN_V1, payload));
    }

    function encodeBurnPayloadV1(BurnPayloadV1 memory p) internal pure returns (bytes memory payload) {
        payload = new bytes(BURN_PAYLOAD_V1_LEN);
        payload[0] = bytes1(p.version);
        _writeLE32(payload, 1, p.sourceDomain);
        _writeLE32(payload, 5, p.destDomain);
        _writeLE64(payload, 9, p.nonce);
        _writeBytes32(payload, 17, p.soraAssetId);
        _writeLE128(payload, 49, p.amount);
        _writeBytes32(payload, 65, p.recipient);
    }

    function decodeBurnPayloadV1(bytes calldata payload) internal pure returns (BurnPayloadV1 memory p) {
        if (payload.length != BURN_PAYLOAD_V1_LEN) revert InvalidPayloadLength(payload.length);
        p.version = uint8(payload[0]);
        p.sourceDomain = _readLE32(payload, 1);
        p.destDomain = _readLE32(payload, 5);
        p.nonce = _readLE64(payload, 9);
        p.soraAssetId = _readBytes32(payload, 17);
        p.amount = _readLE128(payload, 49);
        p.recipient = _readBytes32(payload, 65);
    }

    function _writeBytes32(bytes memory b, uint256 off, bytes32 v) private pure {
        assembly {
            mstore(add(add(b, 32), off), v)
        }
    }

    function _writeLE32(bytes memory b, uint256 off, uint32 v) private pure {
        b[off] = bytes1(uint8(v));
        b[off + 1] = bytes1(uint8(v >> 8));
        b[off + 2] = bytes1(uint8(v >> 16));
        b[off + 3] = bytes1(uint8(v >> 24));
    }

    function _writeLE64(bytes memory b, uint256 off, uint64 v) private pure {
        b[off] = bytes1(uint8(v));
        b[off + 1] = bytes1(uint8(v >> 8));
        b[off + 2] = bytes1(uint8(v >> 16));
        b[off + 3] = bytes1(uint8(v >> 24));
        b[off + 4] = bytes1(uint8(v >> 32));
        b[off + 5] = bytes1(uint8(v >> 40));
        b[off + 6] = bytes1(uint8(v >> 48));
        b[off + 7] = bytes1(uint8(v >> 56));
    }

    function _writeLE128(bytes memory b, uint256 off, uint128 v) private pure {
        b[off] = bytes1(uint8(v));
        b[off + 1] = bytes1(uint8(v >> 8));
        b[off + 2] = bytes1(uint8(v >> 16));
        b[off + 3] = bytes1(uint8(v >> 24));
        b[off + 4] = bytes1(uint8(v >> 32));
        b[off + 5] = bytes1(uint8(v >> 40));
        b[off + 6] = bytes1(uint8(v >> 48));
        b[off + 7] = bytes1(uint8(v >> 56));
        b[off + 8] = bytes1(uint8(v >> 64));
        b[off + 9] = bytes1(uint8(v >> 72));
        b[off + 10] = bytes1(uint8(v >> 80));
        b[off + 11] = bytes1(uint8(v >> 88));
        b[off + 12] = bytes1(uint8(v >> 96));
        b[off + 13] = bytes1(uint8(v >> 104));
        b[off + 14] = bytes1(uint8(v >> 112));
        b[off + 15] = bytes1(uint8(v >> 120));
    }

    function _readBytes32(bytes calldata b, uint256 off) private pure returns (bytes32 out) {
        assembly {
            out := calldataload(add(b.offset, off))
        }
    }

    function _readLE32(bytes calldata b, uint256 off) private pure returns (uint32 v) {
        v =
            uint32(uint8(b[off])) |
            (uint32(uint8(b[off + 1])) << 8) |
            (uint32(uint8(b[off + 2])) << 16) |
            (uint32(uint8(b[off + 3])) << 24);
    }

    function _readLE64(bytes calldata b, uint256 off) private pure returns (uint64 v) {
        v =
            uint64(uint8(b[off])) |
            (uint64(uint8(b[off + 1])) << 8) |
            (uint64(uint8(b[off + 2])) << 16) |
            (uint64(uint8(b[off + 3])) << 24) |
            (uint64(uint8(b[off + 4])) << 32) |
            (uint64(uint8(b[off + 5])) << 40) |
            (uint64(uint8(b[off + 6])) << 48) |
            (uint64(uint8(b[off + 7])) << 56);
    }

    function _readLE128(bytes calldata b, uint256 off) private pure returns (uint128 v) {
        // Loop keeps compiler stack usage low compared to a giant OR expression.
        for (uint256 i = 0; i < 16; i++) {
            v |= uint128(uint256(uint8(b[off + i])) << (8 * i));
        }
    }
}
