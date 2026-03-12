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
        next.push(a);
        continue;
      }
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

function sccpDigestScale(ethers, messageId) {
  return ethers.concat([
    '0x04', // compact vec len = 1
    '0x00', // item kind: commitment
    '0x02', // GenericNetworkId::EVM legacy
    '0x50434353', // LE32(0x53434350)
    messageId,
  ]);
}

function compactU32Inline(value) {
  if (!Number.isInteger(value) || value < 0 || value > 63) {
    throw new Error(`compactU32Inline supports values in [0,63], got ${value}`);
  }
  return `0x${(value << 2).toString(16).padStart(2, '0')}`;
}

function sccpDigestCommitmentLegacyItem(ethers, commitmentHash) {
  return ethers.concat([
    '0x00', // item kind: commitment
    '0x02', // GenericNetworkId::EVM legacy
    '0x50434353', // LE32(0x53434350)
    commitmentHash,
  ]);
}

function sccpDigestScaleFromItems(ethers, items) {
  return ethers.concat([compactU32Inline(items.length), ...items]);
}

function text32(s, ethers) {
  return ethers.encodeBytes32String(s);
}

async function setupVerifierFixture() {
  const { ethers } = await network.connect();

  const validators = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom());
  const leafHashes = validators.map((w) => ethers.keccak256(ethers.getBytes(w.address)));
  const merkle = merkleTreeFromLeaves(ethers, leafHashes);

  const current = { id: 1n, len: 4, root: merkle.root };
  const next = { id: 2n, len: 4, root: merkle.root };

  const Verifier = await ethers.getContractFactory('SoraBeefyLightClientVerifier');
  const verifier = await Verifier.deploy(0n, current, next);
  await verifier.waitForDeployment();

  const CodecTest = await ethers.getContractFactory('SccpCodecTest');
  const codec = await CodecTest.deploy();
  await codec.waitForDeployment();

  return { ethers, validators, merkle, verifier, codec };
}

async function importMessageId({ ethers, validators, merkle, verifier, messageId, blockNumber, digestScaleOverride }) {
  const digestScale = digestScaleOverride ?? sccpDigestScale(ethers, messageId);

  const leaf = {
    version: 0,
    parentNumber: 1,
    parentHash: ethers.keccak256('0x01'),
    nextAuthoritySetId: 2n,
    nextAuthoritySetLen: 4,
    nextAuthoritySetRoot: merkle.root,
    randomSeed: ethers.keccak256('0x02'),
    digestHash: ethers.keccak256(digestScale),
  };

  const mmrRoot = await verifier.hashLeaf(leaf);
  const commitment = { mmrRoot, blockNumber, validatorSetId: 1n };
  const commitmentHash = await verifier.hashCommitment(commitment);

  const positions = [0, 1, 2];
  const signatures = positions.map((idx) => validators[idx].signingKey.sign(commitmentHash).serialized);
  const validatorProof = {
    signatures,
    positions,
    publicKeys: positions.map((idx) => validators[idx].address),
    publicKeyMerkleProofs: positions.map((idx) => merkleProofForIndex(merkle.layers, idx)),
  };

  const mmrProof = { leafIndex: 0n, leafCount: 1n, items: [] };
  await (await verifier.submitSignatureCommitment(commitment, validatorProof, leaf, mmrProof)).wait();

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const proofBytes = coder.encode(
    [
      'uint64',
      'uint64',
      'bytes32[]',
      'tuple(uint8 version,uint32 parentNumber,bytes32 parentHash,uint64 nextAuthoritySetId,uint32 nextAuthoritySetLen,bytes32 nextAuthoritySetRoot,bytes32 randomSeed,bytes32 digestHash)',
      'bytes',
    ],
    [0n, 1n, [], leaf, digestScale],
  );

  return { proofBytes };
}

describe('SoraBeefyLightClientVerifier (constructor bootstrap + typed proofs)', function () {
  it('rejects invalid bootstrap validator sets', async function () {
    const { ethers } = await network.connect();
    const Verifier = await ethers.getContractFactory('SoraBeefyLightClientVerifier');
    const contractLike = { interface: Verifier.interface };

    await expectCustomError(
      Verifier.deploy(0n, { id: 1n, len: 0, root: ethers.ZeroHash }, { id: 2n, len: 1, root: ethers.keccak256('0x01') }),
      contractLike,
      'InvalidValidatorProof',
    );

    await expectCustomError(
      Verifier.deploy(0n, { id: 2n, len: 1, root: ethers.keccak256('0x01') }, { id: 2n, len: 1, root: ethers.keccak256('0x02') }),
      contractLike,
      'InvalidValidatorSetId',
    );
  });

  it('imports finalized roots and verifies burn/add/pause/resume message proofs', async function () {
    const { ethers, validators, merkle, verifier, codec } = await setupVerifierFixture();

    const DOMAIN_SORA = 0;
    const DOMAIN_TRON = 5;
    const soraAssetId = `0x${'11'.repeat(32)}`;

    const burnPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      1,
      soraAssetId,
      1,
      ethers.zeroPadValue(validators[0].address, 32),
    );
    const burnMessageId = await codec.burnMessageId(burnPayload);
    const burnProof = await importMessageId({
      ethers,
      validators,
      merkle,
      verifier,
      messageId: burnMessageId,
      blockNumber: 1,
    });

    expect(await verifier.verifyBurnProof(DOMAIN_SORA, burnMessageId, burnPayload, burnProof.proofBytes)).to.equal(true);

    const addPayload = await codec.encodeTokenAddPayloadV1(
      DOMAIN_TRON,
      2,
      soraAssetId,
      18,
      text32('SCCP Wrapped', ethers),
      text32('wSORA', ethers),
    );
    const addMessageId = await codec.tokenAddMessageId(addPayload);
    const addProof = await importMessageId({
      ethers,
      validators,
      merkle,
      verifier,
      messageId: addMessageId,
      blockNumber: 2,
    });
    expect(await verifier.verifyTokenAddProof(addMessageId, addPayload, addProof.proofBytes)).to.equal(true);

    const pausePayload = await codec.encodeTokenPausePayloadV1(DOMAIN_TRON, 3, soraAssetId);
    const pauseMessageId = await codec.tokenPauseMessageId(pausePayload);
    const pauseProof = await importMessageId({
      ethers,
      validators,
      merkle,
      verifier,
      messageId: pauseMessageId,
      blockNumber: 3,
    });
    expect(await verifier.verifyTokenPauseProof(pauseMessageId, pausePayload, pauseProof.proofBytes)).to.equal(true);

    const resumePayload = await codec.encodeTokenResumePayloadV1(DOMAIN_TRON, 4, soraAssetId);
    const resumeMessageId = await codec.tokenResumeMessageId(resumePayload);
    const resumeProof = await importMessageId({
      ethers,
      validators,
      merkle,
      verifier,
      messageId: resumeMessageId,
      blockNumber: 4,
    });
    expect(await verifier.verifyTokenResumeProof(resumeMessageId, resumePayload, resumeProof.proofBytes)).to.equal(true);
  });

  it('fails closed on message-id mismatch and malformed proof bytes', async function () {
    const { ethers, validators, merkle, verifier, codec } = await setupVerifierFixture();

    const DOMAIN_SORA = 0;
    const DOMAIN_TRON = 5;
    const soraAssetId = `0x${'22'.repeat(32)}`;

    const burnPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      11,
      soraAssetId,
      5,
      ethers.zeroPadValue(validators[0].address, 32),
    );
    const burnMessageId = await codec.burnMessageId(burnPayload);
    await importMessageId({
      ethers,
      validators,
      merkle,
      verifier,
      messageId: burnMessageId,
      blockNumber: 1,
    });

    expect(await verifier.verifyBurnProof(DOMAIN_SORA, ethers.ZeroHash, burnPayload, '0x')).to.equal(false);
    expect(await verifier.verifyBurnProof(DOMAIN_SORA, burnMessageId, burnPayload, '0x1234')).to.equal(false);

    const addPayload = await codec.encodeTokenAddPayloadV1(
      DOMAIN_TRON,
      2,
      soraAssetId,
      18,
      text32('Token', ethers),
      text32('TOK', ethers),
    );
    const addMessageId = await codec.tokenAddMessageId(addPayload);
    expect(await verifier.verifyTokenAddProof(addMessageId, addPayload, '0x1234')).to.equal(false);
  });

  it('fails closed on adversarial digest scale payloads', async function () {
    const { ethers, validators, merkle, verifier, codec } = await setupVerifierFixture();

    const DOMAIN_SORA = 0;
    const DOMAIN_TRON = 5;
    const soraAssetId = `0x${'29'.repeat(32)}`;

    const burnPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      21,
      soraAssetId,
      3,
      ethers.zeroPadValue(validators[0].address, 32),
    );
    const burnMessageId = await codec.burnMessageId(burnPayload);

    const canonicalItem = sccpDigestCommitmentLegacyItem(ethers, burnMessageId);
    const cases = [
      {
        name: 'duplicate commitment entries',
        digestScale: sccpDigestScaleFromItems(ethers, [canonicalItem, canonicalItem]),
      },
      {
        name: 'trailing bytes after canonical vector',
        digestScale: ethers.concat([sccpDigestScale(ethers, burnMessageId), '0x00']),
      },
      {
        name: 'unsupported compact-u32 mode=3 header',
        digestScale: '0x03',
      },
      {
        name: 'unknown GenericNetworkId discriminator',
        digestScale: ethers.concat(['0x04', '0x00', '0xff', burnMessageId]),
      },
    ];

    let blockNumber = 10;
    for (const testCase of cases) {
      const { proofBytes } = await importMessageId({
        ethers,
        validators,
        merkle,
        verifier,
        messageId: burnMessageId,
        blockNumber,
        digestScaleOverride: testCase.digestScale,
      });
      blockNumber += 1;

      expect(
        await verifier.verifyBurnProof(DOMAIN_SORA, burnMessageId, burnPayload, proofBytes),
        testCase.name,
      ).to.equal(false);
    }
  });

  it('rejects commitments with insufficient validator signatures', async function () {
    const { ethers, validators, merkle, verifier } = await setupVerifierFixture();

    const messageId = ethers.keccak256('0x1234');
    const digestScale = sccpDigestScale(ethers, messageId);

    const leaf = {
      version: 0,
      parentNumber: 1,
      parentHash: ethers.keccak256('0x01'),
      nextAuthoritySetId: 2n,
      nextAuthoritySetLen: 4,
      nextAuthoritySetRoot: merkle.root,
      randomSeed: ethers.keccak256('0x02'),
      digestHash: ethers.keccak256(digestScale),
    };
    const mmrRoot = await verifier.hashLeaf(leaf);
    const commitment = { mmrRoot, blockNumber: 1, validatorSetId: 1n };
    const commitmentHash = await verifier.hashCommitment(commitment);

    const positions = [0, 1];
    const validatorProof = {
      signatures: positions.map((idx) => validators[idx].signingKey.sign(commitmentHash).serialized),
      positions,
      publicKeys: positions.map((idx) => validators[idx].address),
      publicKeyMerkleProofs: positions.map((idx) => merkleProofForIndex(merkle.layers, idx)),
    };

    await expectCustomError(
      verifier.submitSignatureCommitment(commitment, validatorProof, leaf, { leafIndex: 0n, leafCount: 1n, items: [] }),
      verifier,
      'NotEnoughValidatorSignatures',
    );
  });

  it('rejects commitments with duplicate validator positions even when signatures meet threshold', async function () {
    const { ethers, validators, merkle, verifier } = await setupVerifierFixture();

    const messageId = ethers.keccak256('0x5678');
    const digestScale = sccpDigestScale(ethers, messageId);

    const leaf = {
      version: 0,
      parentNumber: 1,
      parentHash: ethers.keccak256('0x01'),
      nextAuthoritySetId: 2n,
      nextAuthoritySetLen: 4,
      nextAuthoritySetRoot: merkle.root,
      randomSeed: ethers.keccak256('0x02'),
      digestHash: ethers.keccak256(digestScale),
    };
    const mmrRoot = await verifier.hashLeaf(leaf);
    const commitment = { mmrRoot, blockNumber: 1, validatorSetId: 1n };
    const commitmentHash = await verifier.hashCommitment(commitment);

    const positions = [0, 0, 1];
    const validatorProof = {
      signatures: positions.map((idx) => validators[idx].signingKey.sign(commitmentHash).serialized),
      positions,
      publicKeys: positions.map((idx) => validators[idx].address),
      publicKeyMerkleProofs: positions.map((idx) => merkleProofForIndex(merkle.layers, idx)),
    };

    await expectCustomError(
      verifier.submitSignatureCommitment(commitment, validatorProof, leaf, { leafIndex: 0n, leafCount: 1n, items: [] }),
      verifier,
      'InvalidValidatorProof',
    );
  });
});
