// SPDX-License-Identifier: BSD-4-Clause
pragma solidity ^0.8.23;

import "./ISccpVerifier.sol";
import "./SccpCodec.sol";
import "./SccpToken.sol";

/// @notice SCCP router for EVM chains.
///
/// Users burn wrapped tokens on this chain to create an on-chain burn record + message id.
/// A target chain can later verify the burn via an on-chain verifier (light client) and mint.
///
/// This contract is intentionally fail-closed until a proper verifier is configured.
contract SccpRouter {
    using SccpCodec for bytes;

    // Domain ids (must match SORA pallet constants).
    uint32 public constant DOMAIN_SORA = 0;
    uint32 public constant DOMAIN_ETH = 1;
    uint32 public constant DOMAIN_BSC = 2;
    uint32 public constant DOMAIN_SOL = 3;
    uint32 public constant DOMAIN_TON = 4;
    uint32 public constant DOMAIN_TRON = 5;

    error ZeroAddress();
    error OnlyGovernor();
    error TokenAlreadyRegistered();
    error TokenNotRegistered();
    error AmountIsZero();
    error RecipientIsZero();
    error DomainUnsupported();
    error DomainEqualsLocal();
    error NonceOverflow();
    error BurnRecordAlreadyExists();
    error BurnRecordNotFound();
    error InboundAlreadyProcessed();
    error InboundDomainPaused();
    error OutboundDomainPaused();
    error ProofInvalidated();
    error ProofVerificationFailed();
    error VerifierNotSet();
    error AmountTooLarge();
    error RecipientNotCanonical();

    event GovernorSet(address indexed governor);
    event VerifierSet(address indexed verifier);

    event TokenDeployed(bytes32 indexed soraAssetId, address token, uint8 decimals);
    event InboundDomainPausedSet(uint32 indexed sourceDomain, bool paused);
    event OutboundDomainPausedSet(uint32 indexed destDomain, bool paused);
    event InboundMessageInvalidated(uint32 indexed sourceDomain, bytes32 indexed messageId, bool invalidated);

    event SccpBurned(
        bytes32 indexed messageId,
        bytes32 indexed soraAssetId,
        address indexed sender,
        uint128 amount,
        uint32 destDomain,
        bytes32 recipient,
        uint64 nonce,
        bytes payload
    );

    event SccpMinted(
        bytes32 indexed messageId,
        bytes32 indexed soraAssetId,
        address indexed recipient,
        uint128 amount
    );

    struct BurnRecord {
        address sender;
        bytes32 soraAssetId;
        uint128 amount;
        uint32 destDomain;
        bytes32 recipient;
        uint64 nonce;
        uint64 blockNumber;
    }

    uint32 public immutable localDomain;

    address public governor;
    ISccpVerifier public verifier;

    uint64 public outboundNonce;

    mapping(bytes32 => address) public tokenBySoraAssetId;
    mapping(bytes32 => BurnRecord) public burns;

    mapping(bytes32 => bool) public processedInbound;
    mapping(uint32 => bool) public inboundDomainPaused;
    mapping(uint32 => bool) public outboundDomainPaused;
    mapping(uint32 => mapping(bytes32 => bool)) public invalidatedInbound;

    modifier onlyGovernor() {
        if (msg.sender != governor) revert OnlyGovernor();
        _;
    }

    constructor(uint32 localDomain_, address governor_) {
        if (governor_ == address(0)) revert ZeroAddress();
        _ensure_supported_domain(localDomain_);
        localDomain = localDomain_;
        governor = governor_;
        emit GovernorSet(governor_);
    }

    function setGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        governor = newGovernor;
        emit GovernorSet(newGovernor);
    }

    function setVerifier(address verifier_) external onlyGovernor {
        verifier = ISccpVerifier(verifier_);
        emit VerifierSet(verifier_);
    }

    /// @notice Deploy and register a wrapped token for a given SORA asset id.
    function deployToken(
        bytes32 soraAssetId,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external onlyGovernor returns (address token) {
        if (tokenBySoraAssetId[soraAssetId] != address(0)) revert TokenAlreadyRegistered();
        SccpToken t = new SccpToken(name, symbol, decimals, address(this));
        token = address(t);
        tokenBySoraAssetId[soraAssetId] = token;
        emit TokenDeployed(soraAssetId, token, decimals);
    }

    /// @notice Burn wrapped tokens on this chain to create a burn message for `destDomain`.
    /// @dev Caller must `approve(router, amount)` on the wrapped token first.
    function burnToDomain(
        bytes32 soraAssetId,
        uint256 amount,
        uint32 destDomain,
        bytes32 recipient
    ) external returns (bytes32 messageId) {
        if (amount == 0) revert AmountIsZero();
        if (recipient == bytes32(0)) revert RecipientIsZero();
        if (destDomain == localDomain) revert DomainEqualsLocal();
        _ensure_supported_domain(destDomain);
        if (outboundDomainPaused[destDomain]) revert OutboundDomainPaused();

        // If the destination is an EVM chain, enforce canonical encoding:
        // address right-aligned in 32 bytes and non-zero.
        if (_is_evm_domain(destDomain)) {
            if ((uint256(recipient) >> 160) != 0) revert RecipientNotCanonical();
            if (address(uint160(uint256(recipient))) == address(0)) revert RecipientIsZero();
        }

        address token = tokenBySoraAssetId[soraAssetId];
        if (token == address(0)) revert TokenNotRegistered();

        if (outboundNonce == type(uint64).max) revert NonceOverflow();
        outboundNonce += 1;

        if (amount > type(uint128).max) revert AmountTooLarge();
        uint128 amt = uint128(amount);

        SccpCodec.BurnPayloadV1 memory p = SccpCodec.BurnPayloadV1({
            version: 1,
            sourceDomain: localDomain,
            destDomain: destDomain,
            nonce: outboundNonce,
            soraAssetId: soraAssetId,
            amount: amt,
            recipient: recipient
        });
        bytes memory payload = SccpCodec.encodeBurnPayloadV1(p);
        messageId = SccpCodec.burnMessageId(payload);

        if (burns[messageId].sender != address(0)) revert BurnRecordAlreadyExists();

        SccpToken(token).burnFrom(msg.sender, amount);

        burns[messageId] = BurnRecord({
            sender: msg.sender,
            soraAssetId: soraAssetId,
            amount: amt,
            destDomain: destDomain,
            recipient: recipient,
            nonce: outboundNonce,
            blockNumber: uint64(block.number)
        });

        emit SccpBurned(messageId, soraAssetId, msg.sender, amt, destDomain, recipient, outboundNonce, payload);
    }

    /// @notice Reconstruct the canonical payload bytes for a burn record.
    function burnPayload(bytes32 messageId) external view returns (bytes memory payload) {
        BurnRecord memory r = burns[messageId];
        if (r.sender == address(0)) revert BurnRecordNotFound();
        SccpCodec.BurnPayloadV1 memory p = SccpCodec.BurnPayloadV1({
            version: 1,
            sourceDomain: localDomain,
            destDomain: r.destDomain,
            nonce: r.nonce,
            soraAssetId: r.soraAssetId,
            amount: r.amount,
            recipient: r.recipient
        });
        payload = SccpCodec.encodeBurnPayloadV1(p);
    }

    /// @notice Mint wrapped tokens on this chain based on a verified burn on `sourceDomain`.
    /// @dev Fail-closed until `verifier` is set to an on-chain light client / verifier.
    function mintFromProof(uint32 sourceDomain, bytes calldata payload, bytes calldata proof) external {
        if (address(verifier) == address(0)) revert VerifierNotSet();
        _ensure_supported_domain(sourceDomain);
        if (sourceDomain == localDomain) revert DomainEqualsLocal();
        if (inboundDomainPaused[sourceDomain]) revert InboundDomainPaused();

        bytes32 messageId = SccpCodec.burnMessageId(payload);
        if (invalidatedInbound[sourceDomain][messageId]) revert ProofInvalidated();
        if (processedInbound[messageId]) revert InboundAlreadyProcessed();

        SccpCodec.BurnPayloadV1 memory p = SccpCodec.decodeBurnPayloadV1(payload);
        if (p.version != 1) revert DomainUnsupported();
        if (p.sourceDomain != sourceDomain) revert DomainUnsupported();
        if (p.destDomain != localDomain) revert DomainUnsupported();
        if (p.amount == 0) revert AmountIsZero();
        if (p.recipient == bytes32(0)) revert RecipientIsZero();

        address token = tokenBySoraAssetId[p.soraAssetId];
        if (token == address(0)) revert TokenNotRegistered();

        bool ok = verifier.verifyBurnProof(sourceDomain, messageId, payload, proof);
        if (!ok) revert ProofVerificationFailed();

        // EVM recipient encoding: 20-byte address right-aligned in a 32-byte field.
        if ((uint256(p.recipient) >> 160) != 0) revert RecipientNotCanonical();
        address recipient = address(uint160(uint256(p.recipient)));
        if (recipient == address(0)) revert RecipientIsZero();
        SccpToken(token).mint(recipient, uint256(p.amount));

        processedInbound[messageId] = true;
        emit SccpMinted(messageId, p.soraAssetId, recipient, p.amount);
    }

    function setInboundDomainPaused(uint32 sourceDomain, bool paused) external onlyGovernor {
        if (sourceDomain == localDomain) revert DomainEqualsLocal();
        _ensure_supported_domain(sourceDomain);
        inboundDomainPaused[sourceDomain] = paused;
        emit InboundDomainPausedSet(sourceDomain, paused);
    }

    function setOutboundDomainPaused(uint32 destDomain, bool paused) external onlyGovernor {
        if (destDomain == localDomain) revert DomainEqualsLocal();
        _ensure_supported_domain(destDomain);
        outboundDomainPaused[destDomain] = paused;
        emit OutboundDomainPausedSet(destDomain, paused);
    }

    function invalidateInboundMessage(uint32 sourceDomain, bytes32 messageId, bool invalidated) external onlyGovernor {
        if (sourceDomain == localDomain) revert DomainEqualsLocal();
        _ensure_supported_domain(sourceDomain);
        invalidatedInbound[sourceDomain][messageId] = invalidated;
        emit InboundMessageInvalidated(sourceDomain, messageId, invalidated);
    }

    function _ensure_supported_domain(uint32 domain) internal pure {
        if (
            domain != DOMAIN_SORA &&
            domain != DOMAIN_ETH &&
            domain != DOMAIN_BSC &&
            domain != DOMAIN_SOL &&
            domain != DOMAIN_TON &&
            domain != DOMAIN_TRON
        ) revert DomainUnsupported();
    }

    function _is_evm_domain(uint32 domain) internal pure returns (bool) {
        return domain == DOMAIN_ETH || domain == DOMAIN_BSC || domain == DOMAIN_TRON;
    }
}
