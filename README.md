# sccp-tron

SORA Cross-Chain Protocol (SCCP) contracts for EVM chains (TRON).

See `contracts/` for:
- `SccpRouter`: burn wrapped tokens to create an on-chain SCCP burn message + `messageId`
- `SccpToken`: minimal ERC-20 used as the wrapped representation of a SORA asset
- `ISccpVerifier`: pluggable on-chain verifier interface (light client / consensus proofs)

`mintFromProof` is **fail-closed** until a real verifier contract is configured.
Router hardening is also fail-closed for unsupported domains: burn/mint/incident-control calls reject unknown domain IDs.

## Build

```bash
./scripts/compile.sh
```

## Deploy (high level)

1. Deploy `SccpRouter` with:
   - `localDomain = 5` (TRON)
   - `governor = <your on-chain governance address>`
2. For each SORA `asset_id` you want to bridge, deploy/register a wrapped token:
   - call `SccpRouter.deployToken(soraAssetId, name, symbol, decimals)`
3. On SORA (runtime pallet `sccp`):
   - call `set_domain_endpoint(SCCP_DOMAIN_TRON, <router address bytes>)`
   - call `set_remote_token(asset_id, SCCP_DOMAIN_TRON, <token address bytes>)`
   - after setting all required domains, call `activate_token(asset_id)`

## Mint (Any -> TRON, Via SORA Finality)

Minting on this chain is always driven by **SORA finality**:

- For `SORA -> TRON`, SORA burns and commits `messageId` into its auxiliary digest, and users call:
  - `SccpRouter.mintFromProof(DOMAIN_SORA, payload, soraBeefyMmrProof)`
- For `X -> TRON` where `X != SORA`, SORA must first verify the source-chain burn and commit its `messageId` into the
  auxiliary digest (SORA runtime extrinsic `sccp.attest_burn`). Then users call:
  - `SccpRouter.mintFromProof(sourceDomain = X, payload, soraBeefyMmrProof)`

## Verifier Security Properties (SORA -> TRON)

`SoraBeefyLightClientVerifier` enforces:

- `>= 2/3` validator signatures for each imported BEEFY commitment
- validator merkle-membership proofs against the stored validator set root
- duplicate signer-key rejection in one commitment proof
- ECDSA signature validity checks (`r != 0`, `s != 0`, and low-`s`)

## Proofs To SORA (TRON As Source Chain)

Inbound proofs from TRON to SORA are finalized on SORA by domain finality mode:

- default mode: `TronLightClient` for `DOMAIN_TRON`
- trustless mode: `TronLightClient` (on-chain TRON header verifier + "solidified block" finality)
  - governance initializes the light client with a checkpoint header and witness set:
    - `sccp.init_tron_light_client(checkpoint_raw_data, checkpoint_witness_signature, witnesses, address_prefix)`
  - governance switches the domain finality mode:
    - `sccp.set_inbound_finality_mode(DOMAIN_TRON, TronLightClient)`
  - anyone can submit subsequent headers to advance head/finality:
    - `sccp.submit_tron_header(raw_data, witness_signature)`
  - witness-set rotation must be updated by governance when needed:
    - `sccp.set_tron_witnesses(witnesses)`

Temporary fallback is available via `EvmAnchor` mode if governance explicitly opts in:
- `sccp.set_inbound_finality_mode(DOMAIN_TRON, EvmAnchor)`
- `sccp.set_evm_anchor_mode_enabled(DOMAIN_TRON, true)`
- `sccp.set_evm_inbound_anchor(DOMAIN_TRON, block_number, block_hash, state_root)`

An alternative temporary override is available via `AttesterQuorum` (CCTP-style threshold ECDSA signatures over `messageId`).

To encode `AttesterQuorum` proof bytes for SORA submission:

```bash
npm run encode-attester-proof -- --message-id 0x<messageId32> --sig 0x<sig65> --sig 0x<sig65>
```

## Proof Generation (bridge-relayer)

Use `bridge-relayer` to build on-chain proof inputs:

1. Export verifier init sets:
   - `sccp evm init`
2. Import finalized SORA MMR roots:
   - `sccp evm import-root --justification-block <beefy_block>`
3. Build mint proof payload for `verifyBurnProof` / `mintFromProof`:
   - `sccp evm mint-proof --burn-block <burn_block> --beefy-block <beefy_block> --message-id 0x... --abi`

`--abi` returns the exact ABI bytes expected by `SoraBeefyLightClientVerifier.verifyBurnProof`.
