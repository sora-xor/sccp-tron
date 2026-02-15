# SCCP Message Format (v1)

This repo follows the SCCP message format pinned by the SORA runtime pallet `sccp`.

## Domains

- `0`: SORA
- `1`: Ethereum
- `2`: BSC
- `3`: Solana
- `4`: TON
- `5`: TRON

## BurnPayloadV1

Fields (in order):

1. `version: u8` (must be `1`)
2. `source_domain: u32` (little-endian)
3. `dest_domain: u32` (little-endian)
4. `nonce: u64` (little-endian)
5. `sora_asset_id: [u8; 32]`
6. `amount: u128` (little-endian)
7. `recipient: [u8; 32]`

Encoding: Substrate SCALE encoding for fixed-width primitives (no compact encoding is used here).

Total encoded length: `97` bytes.

## messageId

On all chains, the canonical message id is:

`messageId = keccak256(b"sccp:burn:v1" || payload_scale_bytes)`

Where `payload_scale_bytes` is the SCALE encoding of `BurnPayloadV1`.

## Recipient Encoding

`recipient` is always 32 bytes. Each chain interprets it differently:

- EVM (ETH/BSC/TRON): `address` right-aligned (last 20 bytes), i.e. `address(uint160(uint256(recipient)))`.
  - Canonical encoding is enforced on-chain: the top 12 bytes must be zero and the address must be non-zero.
- Solana: 32-byte ed25519 public key
- TON: 32-byte address/public-key representation (project-specific; must be consistent across contracts and off-chain tooling)

## Remote Token IDs (stored on SORA)

When SORA governance adds an SCCP token, it stores each remote representation id:

- EVM (ETH/BSC/TRON): 20 bytes (contract address)
- Solana: 32 bytes (mint)
- TON: 32 bytes (jetton master)

## BEEFY Validator Merkle Proofs (SORA -> EVM)

The EVM verifier contract (`SoraBeefyLightClientVerifier`) is a BEEFY+MMR light client.

When importing a BEEFY commitment, signers must prove membership in the current validator set
using the `nextAuthoritySetRoot` merkle root from the SORA MMR leaf.

Root construction matches Substrate `binary_merkle_tree` (no sorting):

- Leaves: `leaf = keccak256(bytes20(validator_eth_address))`
- Internal nodes: `parent = keccak256(left || right)`
- Odd leaf promotion: if a layer has an odd number of nodes, the last node is promoted unchanged

Each signature includes:

- `position`: validator leaf index (0-based) in the set order used by the chain
- `publicKeyMerkleProofs[position]`: sibling hashes along the path (one per tree level where a sibling exists)
- ECDSA signature validity rules: `r != 0`, `s != 0`, and `s <= secp256k1n / 2` (reject high-`s` malleability)
- duplicate signer keys are rejected in one commitment proof (fail-closed)

## Proofs To SORA Finality (TRON Source)

For inbound TRON -> SORA verification, SORA runtime supports:

- `InboundFinalityMode::TronLightClient` (trustless): on-chain TRON header verifier + solidified-block finality (>70% distinct witnesses)
  + EVM MPT account/storage proof against the finalized header's execution root (`accountStateRoot`)
- `InboundFinalityMode::EvmAnchor` (fallback/temporary, governance override): EVM MPT proof against a governance-provided anchor `state_root`
- `InboundFinalityMode::AttesterQuorum` (fallback/temporary): threshold ECDSA signatures over `keccak256("sccp:attest:v1" || messageId)`

Required SORA governance configuration:

- `set_inbound_finality_mode(DOMAIN_TRON, EvmAnchor)`
- `set_evm_anchor_mode_enabled(DOMAIN_TRON, true)`
- `set_evm_inbound_anchor(DOMAIN_TRON, block_number, block_hash, state_root)`

To enable trustless mode, SORA governance must initialize the TRON light client and switch the domain finality mode.
