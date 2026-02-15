import { expect } from 'chai';
import { network } from 'hardhat';

async function expectCustomError(promise, contract, name) {
  try {
    await promise;
    throw new Error('expected revert');
  } catch (e) {
    const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
    if (!data) {
      throw e;
    }
    const decoded = contract.interface.parseError(data);
    expect(decoded?.name).to.equal(name);
  }
}

function u8arr(xs) {
  return Uint8Array.from(xs);
}

const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function merkleTreeFromLeaves(ethers, leafHashes) {
  const layers = [];
  layers.push(leafHashes);
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i];
      const b = i + 1 < prev.length ? prev[i + 1] : null;
      if (b === null) {
        next.push(a); // promote odd leaf
        continue;
      }
      // Substrate `binary_merkle_tree`: ordered hashing (no sorting).
      next.push(ethers.keccak256(ethers.concat([a, b])));
    }
    layers.push(next);
  }
  return { layers, root: layers[layers.length - 1][0] };
}

function merkleProofForIndex(layers, leafIndex) {
  const proof = [];
  let idx = leafIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRight = idx % 2 === 1;
    const sibling = isRight ? idx - 1 : idx + 1;
    if (sibling < layer.length) {
      proof.push(layer[sibling]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

describe('SORA BEEFY+MMR light client verifier (EVM)', function () {
  it('imports an MMR root and verifies a SORA-attested burn proof end-to-end (any source domain)', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_ETH = 1;
    const DOMAIN_TRON = 5;
    const LOCAL_DOMAIN = DOMAIN_TRON;

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(LOCAL_DOMAIN, governor.address);
    await router.waitForDeployment();

    const Verifier = await ethers.getContractFactory('SoraBeefyLightClientVerifier');
    const verifier = await Verifier.deploy(governor.address);
    await verifier.waitForDeployment();

    // --- Prepare an ETH -> TRON burn payload/messageId (what we will mint from) ---
    const soraAssetId = `0x${'11'.repeat(32)}`;
    await (await router.connect(governor).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const recipient32 = ethers.zeroPadValue(user.address, 32);
    // Treat this as "ETH -> TRON burn, attested/finalized by SORA and committed in its digest".
    const payload = await codec.encodeBurnPayloadV1(DOMAIN_ETH, LOCAL_DOMAIN, 1, soraAssetId, 100, recipient32);
    const messageId = await codec.burnMessageId(payload);

    // --- Craft SCALE(AuxiliaryDigest) bytes that contain SCCP commitment(messageId) ---
    // Vec len = 1 => compact(1) = 0x04
    // AuxiliaryDigestItem::Commitment => variant 0x00
    // GenericNetworkId::EVMLegacy => variant 0x02
    // u32('SCCP') little-endian = 0x53434350 => 50 43 43 53
    const digestScale = ethers.concat([
      u8arr([0x04, 0x00, 0x02, 0x50, 0x43, 0x43, 0x53]),
      messageId,
    ]);
    const digestHash = ethers.keccak256(digestScale);

    // --- Bootstrap validator sets (synthetic) ---
    const validators = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom());
    const leafHashes = validators.map((w) => ethers.keccak256(ethers.getBytes(w.address)));
    const { layers, root: vsetRoot } = merkleTreeFromLeaves(ethers, leafHashes);

    const currentVset = { id: 1n, len: 4, root: vsetRoot };
    const nextVset = { id: 2n, len: 4, root: vsetRoot };
    await (await verifier.connect(governor).initialize(0n, currentVset, nextVset)).wait();

    // --- Build an MMR leaf whose digestHash matches keccak256(digestScale) ---
    const leaf = {
      version: 0,
      parentNumber: 123,
      parentHash: ethers.keccak256('0x1234'),
      nextAuthoritySetId: 2n,
      nextAuthoritySetLen: 4,
      nextAuthoritySetRoot: vsetRoot,
      randomSeed: ethers.keccak256('0xbeef'),
      digestHash: digestHash,
    };

    const leafHash = await verifier.hashLeaf(leaf);
    // --- Craft a real Substrate-style MMR root for a small leaf set (3 leaves) ---
    //
    // For 3 leaves, peaks are:
    // - peak0 = hash(leaf0, leaf1)
    // - peak1 = leaf2
    // root = hash(peak1, peak0)  (bagging right-to-left)
    const leaf1Hash = ethers.keccak256('0xaaaa');
    const leaf2Hash = ethers.keccak256('0xbbbb');
    const peak0 = ethers.keccak256(ethers.concat([leafHash, leaf1Hash]));
    const mmrRoot = ethers.keccak256(ethers.concat([leaf2Hash, peak0]));

    const commitment = { mmrRoot: mmrRoot, blockNumber: 1, validatorSetId: 1n };
    const commitmentHash = await verifier.hashCommitment(commitment);

    // Threshold for 4 validators is 3 signatures.
    const sigs = validators.slice(0, 3).map((w) => w.signingKey.sign(commitmentHash).serialized);
    const pubKeys = validators.slice(0, 3).map((w) => w.address);
    const positions = [0, 1, 2];
    const merkleProofs = [0, 1, 2].map((i) => merkleProofForIndex(layers, i));

    const validatorProof = {
      signatures: sigs,
      positions: positions,
      publicKeys: pubKeys,
      publicKeyMerkleProofs: merkleProofs,
    };
    const mmrProof = { leafIndex: 0n, leafCount: 3n, items: [leaf1Hash, leaf2Hash] };

    // Import the (synthetic) finalized MMR root.
    await (await verifier.submitSignatureCommitment(commitment, validatorProof, leaf, mmrProof)).wait();

    // Wire verifier into router.
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();

    // Proof format: abi.encode(uint64 leafIndex, uint64 leafCount, bytes32[] items, MmrLeaf leaf, bytes digestScale)
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const proofBytes = coder.encode(
      [
        'uint64',
        'uint64',
        'bytes32[]',
        'tuple(uint8 version,uint32 parentNumber,bytes32 parentHash,uint64 nextAuthoritySetId,uint32 nextAuthoritySetLen,bytes32 nextAuthoritySetRoot,bytes32 randomSeed,bytes32 digestHash)',
        'bytes',
      ],
      [0n, 3n, [leaf1Hash, leaf2Hash], leaf, digestScale],
    );

    await (await router.mintFromProof(DOMAIN_ETH, payload, proofBytes)).wait();

    const tokenAddr = await router.tokenBySoraAssetId(soraAssetId);
    const token = await ethers.getContractAt('SccpToken', tokenAddr);
    expect(await token.balanceOf(user.address)).to.equal(100n);
  });

  it('rejects duplicate validator keys even with unique positions', async function () {
    const { ethers } = await network.connect();
    const [governor] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory('SoraBeefyLightClientVerifier');
    const verifier = await Verifier.deploy(governor.address);
    await verifier.waitForDeployment();

    const validators = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom());
    const leafHashes = validators.map((w) => ethers.keccak256(ethers.getBytes(w.address)));
    const { layers, root: vsetRoot } = merkleTreeFromLeaves(ethers, leafHashes);
    const v = validators[0];
    const vProof = merkleProofForIndex(layers, 0);

    const currentVset = { id: 1n, len: 4, root: vsetRoot };
    const nextVset = { id: 2n, len: 4, root: vsetRoot };
    await (await verifier.connect(governor).initialize(0n, currentVset, nextVset)).wait();

    const digestScale = ethers.concat([u8arr([0x00])]); // invalid; not reached
    const leaf = {
      version: 0,
      parentNumber: 1,
      parentHash: ethers.keccak256('0x01'),
      nextAuthoritySetId: 2n,
      nextAuthoritySetLen: 4,
      nextAuthoritySetRoot: vsetRoot,
      randomSeed: ethers.keccak256('0x02'),
      digestHash: ethers.keccak256(digestScale),
    };

    const leafRoot = await verifier.hashLeaf(leaf);
    const commitment = { mmrRoot: leafRoot, blockNumber: 1, validatorSetId: 1n };
    const commitmentHash = await verifier.hashCommitment(commitment);
    const sig = v.signingKey.sign(commitmentHash).serialized;

    const validatorProof = {
      signatures: [sig, sig, sig],
      positions: [0, 1, 2],
      publicKeys: [v.address, v.address, v.address],
      publicKeyMerkleProofs: [vProof, vProof, vProof],
    };
    // 1-leaf MMR: root == leaf hash, proof items empty.
    const mmrProof = { leafIndex: 0n, leafCount: 1n, items: [] };

    await expectCustomError(
      verifier.submitSignatureCommitment(commitment, validatorProof, leaf, mmrProof),
      verifier,
      'InvalidValidatorProof',
    );
  });

  it('rejects malleable high-s signatures', async function () {
    const { ethers } = await network.connect();
    const [governor] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory('SoraBeefyLightClientVerifier');
    const verifier = await Verifier.deploy(governor.address);
    await verifier.waitForDeployment();

    const validators = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom());
    const leafHashes = validators.map((w) => ethers.keccak256(ethers.getBytes(w.address)));
    const { layers, root: vsetRoot } = merkleTreeFromLeaves(ethers, leafHashes);

    const currentVset = { id: 1n, len: 4, root: vsetRoot };
    const nextVset = { id: 2n, len: 4, root: vsetRoot };
    await (await verifier.connect(governor).initialize(0n, currentVset, nextVset)).wait();

    const digestScale = ethers.concat([u8arr([0x00])]); // invalid; not reached
    const leaf = {
      version: 0,
      parentNumber: 1,
      parentHash: ethers.keccak256('0x01'),
      nextAuthoritySetId: 2n,
      nextAuthoritySetLen: 4,
      nextAuthoritySetRoot: vsetRoot,
      randomSeed: ethers.keccak256('0x02'),
      digestHash: ethers.keccak256(digestScale),
    };

    const leafRoot = await verifier.hashLeaf(leaf);
    const commitment = { mmrRoot: leafRoot, blockNumber: 1, validatorSetId: 1n };
    const commitmentHash = await verifier.hashCommitment(commitment);

    // Malleate the first signature into a high-s equivalent.
    const sig0 = validators[0].signingKey.sign(commitmentHash);
    const highS = SECP256K1N - BigInt(sig0.s);
    const altV = 27 + (sig0.yParity ^ 1);
    const sig0HighS = ethers.concat([
      ethers.zeroPadValue(sig0.r, 32),
      ethers.zeroPadValue(ethers.toBeHex(highS), 32),
      u8arr([altV]),
    ]);

    const validatorProof = {
      signatures: [
        sig0HighS,
        validators[1].signingKey.sign(commitmentHash).serialized,
        validators[2].signingKey.sign(commitmentHash).serialized,
      ],
      positions: [0, 1, 2],
      publicKeys: [validators[0].address, validators[1].address, validators[2].address],
      publicKeyMerkleProofs: [
        merkleProofForIndex(layers, 0),
        merkleProofForIndex(layers, 1),
        merkleProofForIndex(layers, 2),
      ],
    };
    const mmrProof = { leafIndex: 0n, leafCount: 1n, items: [] };

    await expectCustomError(
      verifier.submitSignatureCommitment(commitment, validatorProof, leaf, mmrProof),
      verifier,
      'InvalidSignature',
    );
  });
});
