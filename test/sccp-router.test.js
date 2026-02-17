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

function hexRepeat(byteHexNo0x, nBytes) {
  return `0x${byteHexNo0x.repeat(nBytes)}`;
}

describe('SCCP (EVM) router (TRON)', function () {
  it('codec matches the ETH -> SORA reference vector', async function () {
    const { ethers } = await network.connect();
    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const soraAssetId = hexRepeat('11', 32);
    const recipient32 = hexRepeat('22', 32);

    const payload = await codec.encodeBurnPayloadV1(1, 0, 777, soraAssetId, 10, recipient32);
    const expectedPayload =
      '0x' +
      '01' +
      '01000000' +
      '00000000' +
      '0903000000000000' +
      '11'.repeat(32) +
      '0a' +
      '00'.repeat(15) +
      '22'.repeat(32);

    expect(payload).to.equal(expectedPayload);

    const messageId = await codec.burnMessageId(payload);
    expect(messageId).to.equal(
      '0xf3cac8c5acfb0670a24e9ffeab7e409a9d54d1dc5e6dbaf0ee986462fe1ffb3a',
    );
  });

  it('enforces governor-only admin methods and blocks unverifiable mint attempts', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_SOL = 3;
    const DOMAIN_TRON = 5;

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const soraAssetId = hexRepeat('11', 32);

    await expectCustomError(
      router.connect(user).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18),
      router,
      'OnlyGovernor',
    );
    await expectCustomError(router.connect(user).setVerifier(user.address), router, 'OnlyGovernor');
    await expectCustomError(router.connect(user).setGovernor(user.address), router, 'OnlyGovernor');
    await expectCustomError(router.connect(user).setInboundDomainPaused(DOMAIN_SORA, true), router, 'OnlyGovernor');
    await expectCustomError(router.connect(user).setOutboundDomainPaused(DOMAIN_SOL, true), router, 'OnlyGovernor');
    await expectCustomError(
      router.connect(user).invalidateInboundMessage(DOMAIN_SORA, hexRepeat('aa', 32), true),
      router,
      'OnlyGovernor',
    );

    await expectCustomError(router.mintFromProof(DOMAIN_SORA, '0x', '0x'), router, 'VerifierNotSet');

    const FalseVerifier = await ethers.getContractFactory('AlwaysFalseVerifier');
    const falseVerifier = await FalseVerifier.deploy();
    await falseVerifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await falseVerifier.getAddress())).wait();
    await (await router.connect(governor).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const recipient32 = ethers.zeroPadValue(user.address, 32);
    const payload = await codec.encodeBurnPayloadV1(DOMAIN_SORA, DOMAIN_TRON, 1, soraAssetId, 1, recipient32);
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, payload, '0x1234'),
      router,
      'ProofVerificationFailed',
    );
  });

  it('rejects unknown inbound assets and outbound amounts over u128', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_SOL = 3;
    const DOMAIN_TRON = 5;

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const TrueVerifier = await ethers.getContractFactory('AlwaysTrueVerifier');
    const verifier = await TrueVerifier.deploy();
    await verifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();

    const recipient32 = ethers.zeroPadValue(user.address, 32);
    const unknownAssetId = hexRepeat('99', 32);
    const inboundUnknownTokenPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      7,
      unknownAssetId,
      1,
      recipient32,
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, inboundUnknownTokenPayload, '0x'),
      router,
      'TokenNotRegistered',
    );

    const knownAssetId = hexRepeat('11', 32);
    await (await router.connect(governor).deployToken(knownAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const tooLargeAmount = 1n << 128n;
    const solRecipient32 = hexRepeat('33', 32);
    await expectCustomError(
      router.connect(user).burnToDomain(knownAssetId, tooLargeAmount, DOMAIN_SOL, solRecipient32),
      router,
      'AmountTooLarge',
    );
  });

  it('guards governor transfer and duplicate token registration', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SOL = 3;
    const DOMAIN_TRON = 5;
    const soraAssetId = hexRepeat('11', 32);

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    await expectCustomError(
      router.connect(governor).setGovernor(ethers.ZeroAddress),
      router,
      'ZeroAddress',
    );

    await (await router.connect(governor).setGovernor(user.address)).wait();
    await expectCustomError(
      router.connect(governor).setOutboundDomainPaused(DOMAIN_SOL, true),
      router,
      'OnlyGovernor',
    );

    await (await router.connect(user).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();
    await expectCustomError(
      router.connect(user).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18),
      router,
      'TokenAlreadyRegistered',
    );
  });

  it('rejects malformed inbound payload variants before minting', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_ETH = 1;
    const DOMAIN_SOL = 3;
    const DOMAIN_TRON = 5;
    const soraAssetId = hexRepeat('11', 32);

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const TrueVerifier = await ethers.getContractFactory('AlwaysTrueVerifier');
    const verifier = await TrueVerifier.deploy();
    await verifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();
    await (await router.connect(governor).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const recipient32 = ethers.zeroPadValue(user.address, 32);

    const sourceSoraPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      10,
      soraAssetId,
      1,
      recipient32,
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_ETH, sourceSoraPayload, '0x'),
      router,
      'DomainUnsupported',
    );

    const invalidVersionPayload = `0x02${sourceSoraPayload.slice(4)}`;
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, invalidVersionPayload, '0x'),
      router,
      'DomainUnsupported',
    );

    const wrongDestPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_SOL,
      11,
      soraAssetId,
      1,
      recipient32,
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, wrongDestPayload, '0x'),
      router,
      'DomainUnsupported',
    );

    const zeroAmountPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      12,
      soraAssetId,
      0,
      recipient32,
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, zeroAmountPayload, '0x'),
      router,
      'AmountIsZero',
    );

    const zeroRecipientPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      13,
      soraAssetId,
      1,
      ethers.ZeroHash,
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, zeroRecipientPayload, '0x'),
      router,
      'RecipientIsZero',
    );
  });

  it('rejects outbound burn edge cases for local domain and unknown token', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_TRON = 5;
    const DOMAIN_SOL = 3;

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const unknownAssetId = hexRepeat('99', 32);
    const recipient32 = ethers.zeroPadValue(user.address, 32);

    await expectCustomError(
      router.connect(user).burnToDomain(unknownAssetId, 1n, DOMAIN_TRON, recipient32),
      router,
      'DomainEqualsLocal',
    );
    await expectCustomError(
      router.connect(user).burnToDomain(unknownAssetId, 1n, DOMAIN_SOL, recipient32),
      router,
      'TokenNotRegistered',
    );
    await expectCustomError(
      router.connect(user).burnToDomain(unknownAssetId, 1n, DOMAIN_SOL, ethers.ZeroHash),
      router,
      'RecipientIsZero',
    );
  });

  it('remains fail-closed after verifier is unset and rejects local-domain incident controls', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_TRON = 5;

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const TrueVerifier = await ethers.getContractFactory('AlwaysTrueVerifier');
    const verifier = await TrueVerifier.deploy();
    await verifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();
    await (await router.connect(governor).setVerifier(ethers.ZeroAddress)).wait();

    const payload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      21,
      hexRepeat('11', 32),
      1,
      ethers.zeroPadValue(user.address, 32),
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, payload, '0x'),
      router,
      'VerifierNotSet',
    );

    await expectCustomError(
      router.connect(governor).setInboundDomainPaused(DOMAIN_TRON, true),
      router,
      'DomainEqualsLocal',
    );
    await expectCustomError(
      router.connect(governor).setOutboundDomainPaused(DOMAIN_TRON, true),
      router,
      'DomainEqualsLocal',
    );
    await expectCustomError(
      router.connect(governor).invalidateInboundMessage(DOMAIN_TRON, hexRepeat('aa', 32), true),
      router,
      'DomainEqualsLocal',
    );
    await expectCustomError(
      router.burnPayload(hexRepeat('ff', 32)),
      router,
      'BurnRecordNotFound',
    );
  });

  it('allows governor to revalidate invalidated proofs and resume inbound minting after unpause', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_TRON = 5;
    const soraAssetId = hexRepeat('11', 32);

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(DOMAIN_TRON, governor.address);
    await router.waitForDeployment();

    const TrueVerifier = await ethers.getContractFactory('AlwaysTrueVerifier');
    const verifier = await TrueVerifier.deploy();
    await verifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();
    await (await router.connect(governor).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const tokenAddr = await router.tokenBySoraAssetId(soraAssetId);
    const token = await ethers.getContractAt('SccpToken', tokenAddr);
    const recipient32 = ethers.zeroPadValue(user.address, 32);

    const revalidatedPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      30,
      soraAssetId,
      1,
      recipient32,
    );
    const revalidatedMessageId = await codec.burnMessageId(revalidatedPayload);

    await (await router.connect(governor).invalidateInboundMessage(DOMAIN_SORA, revalidatedMessageId, true)).wait();
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, revalidatedPayload, '0x'),
      router,
      'ProofInvalidated',
    );

    await (await router.connect(governor).invalidateInboundMessage(DOMAIN_SORA, revalidatedMessageId, false)).wait();
    await (await router.mintFromProof(DOMAIN_SORA, revalidatedPayload, '0x')).wait();
    expect(await token.balanceOf(user.address)).to.equal(1n);
    expect(await router.processedInbound(revalidatedMessageId)).to.equal(true);

    const pausedPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      DOMAIN_TRON,
      31,
      soraAssetId,
      1,
      recipient32,
    );
    await (await router.connect(governor).setInboundDomainPaused(DOMAIN_SORA, true)).wait();
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, pausedPayload, '0x'),
      router,
      'InboundDomainPaused',
    );

    await (await router.connect(governor).setInboundDomainPaused(DOMAIN_SORA, false)).wait();
    await (await router.mintFromProof(DOMAIN_SORA, pausedPayload, '0x')).wait();
    expect(await token.balanceOf(user.address)).to.equal(2n);
  });

  it('mint/burn/incident controls work and minting is recipient-canonical', async function () {
    const { ethers } = await network.connect();
    const [governor, user] = await ethers.getSigners();

    const DOMAIN_SORA = 0;
    const DOMAIN_ETH = 1;
    const DOMAIN_BSC = 2;
    const DOMAIN_SOL = 3;
    const DOMAIN_TRON = 5;
    const UNSUPPORTED_DOMAIN = 999;

    const LOCAL_DOMAIN = DOMAIN_TRON;

    const CodecTest = await ethers.getContractFactory('SccpCodecTest');
    const codec = await CodecTest.deploy();
    await codec.waitForDeployment();

    const Router = await ethers.getContractFactory('SccpRouter');
    const router = await Router.deploy(LOCAL_DOMAIN, governor.address);
    await router.waitForDeployment();

    const TrueVerifier = await ethers.getContractFactory('AlwaysTrueVerifier');
    const verifier = await TrueVerifier.deploy();
    await verifier.waitForDeployment();
    await (await router.connect(governor).setVerifier(await verifier.getAddress())).wait();

    const soraAssetId = hexRepeat('11', 32);
    await (await router.connect(governor).deployToken(soraAssetId, 'SCCP Wrapped', 'wSORA', 18)).wait();

    const tokenAddr = await router.tokenBySoraAssetId(soraAssetId);
    const token = await ethers.getContractAt('SccpToken', tokenAddr);

    // --- Inbound mint (SORA -> TRON) ---
    const recipient32 = ethers.zeroPadValue(user.address, 32);
    const inboundPayload = await codec.encodeBurnPayloadV1(
      DOMAIN_SORA,
      LOCAL_DOMAIN,
      1,
      soraAssetId,
      100,
      recipient32,
    );
    const inboundMessageId = await codec.burnMessageId(inboundPayload);

    await (await router.mintFromProof(DOMAIN_SORA, inboundPayload, '0x')).wait();
    expect(await token.balanceOf(user.address)).to.equal(100n);
    expect(await router.processedInbound(inboundMessageId)).to.equal(true);

    // Replay is blocked.
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, inboundPayload, '0x'),
      router,
      'InboundAlreadyProcessed',
    );

    // Unsupported source domain is rejected.
    await expectCustomError(
      router.mintFromProof(UNSUPPORTED_DOMAIN, inboundPayload, '0x'),
      router,
      'DomainUnsupported',
    );

    // Source domain == local domain is blocked.
    await expectCustomError(
      router.mintFromProof(LOCAL_DOMAIN, inboundPayload, '0x'),
      router,
      'DomainEqualsLocal',
    );

    // Recipient canonical encoding enforced for EVM mints.
    const recipientBad = `0x${'11'.repeat(12)}${user.address.slice(2)}`; // non-zero high 12 bytes
    const badPayload = await codec.encodeBurnPayloadV1(DOMAIN_SORA, LOCAL_DOMAIN, 2, soraAssetId, 1, recipientBad);
    await expectCustomError(router.mintFromProof(DOMAIN_SORA, badPayload, '0x'), router, 'RecipientNotCanonical');

    // Invalidate a specific messageId.
    const invPayload = await codec.encodeBurnPayloadV1(DOMAIN_SORA, LOCAL_DOMAIN, 3, soraAssetId, 1, recipient32);
    const invMessageId = await codec.burnMessageId(invPayload);
    await (await router.connect(governor).invalidateInboundMessage(DOMAIN_SORA, invMessageId, true)).wait();
    await expectCustomError(
      router.connect(governor).invalidateInboundMessage(UNSUPPORTED_DOMAIN, invMessageId, true),
      router,
      'DomainUnsupported',
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, invPayload, '0x'),
      router,
      'ProofInvalidated',
    );

    // Pause inbound from SORA.
    const pausedPayload = await codec.encodeBurnPayloadV1(DOMAIN_SORA, LOCAL_DOMAIN, 4, soraAssetId, 1, recipient32);
    await (await router.connect(governor).setInboundDomainPaused(DOMAIN_SORA, true)).wait();
    await expectCustomError(
      router.connect(governor).setInboundDomainPaused(UNSUPPORTED_DOMAIN, true),
      router,
      'DomainUnsupported',
    );
    await expectCustomError(
      router.mintFromProof(DOMAIN_SORA, pausedPayload, '0x'),
      router,
      'InboundDomainPaused',
    );

    // --- Outbound burn (TRON -> SOL) ---
    const burnAmount = 10n;
    await (await token.connect(user).approve(await router.getAddress(), burnAmount)).wait();

    const solRecipient32 = hexRepeat('33', 32);
    const burnMessageId = await router
      .connect(user)
      .burnToDomain.staticCall(soraAssetId, burnAmount, DOMAIN_SOL, solRecipient32);
    await (await router.connect(user).burnToDomain(soraAssetId, burnAmount, DOMAIN_SOL, solRecipient32)).wait();

    expect(await token.balanceOf(user.address)).to.equal(90n);

    const burnPayload = await router.burnPayload(burnMessageId);
    const decoded = await codec.decodeBurnPayloadV1(burnPayload);
    expect(decoded[0]).to.equal(1n);
    expect(decoded[1]).to.equal(BigInt(LOCAL_DOMAIN));
    expect(decoded[2]).to.equal(BigInt(DOMAIN_SOL));
    expect(decoded[3]).to.equal(1n);
    expect(decoded[4]).to.equal(soraAssetId);
    expect(decoded[5]).to.equal(burnAmount);
    expect(decoded[6]).to.equal(solRecipient32);

    // Canonical recipient enforced on outbound when destination is EVM.
    const evmRecipientBad = `0x${'11'.repeat(12)}${user.address.slice(2)}`;
    await (await token.connect(user).approve(await router.getAddress(), 1n)).wait();
    await expectCustomError(
      router.connect(user).burnToDomain(soraAssetId, 1n, DOMAIN_ETH, evmRecipientBad),
      router,
      'RecipientNotCanonical',
    );
    await expectCustomError(
      router.connect(user).burnToDomain(soraAssetId, 1n, UNSUPPORTED_DOMAIN, solRecipient32),
      router,
      'DomainUnsupported',
    );

    // Outbound domain pause blocks burns to that destination.
    await (await router.connect(governor).setOutboundDomainPaused(DOMAIN_SOL, true)).wait();
    await expectCustomError(
      router.connect(governor).setOutboundDomainPaused(UNSUPPORTED_DOMAIN, true),
      router,
      'DomainUnsupported',
    );
    await (await token.connect(user).approve(await router.getAddress(), 1n)).wait();
    await expectCustomError(
      router.connect(user).burnToDomain(soraAssetId, 1n, DOMAIN_SOL, solRecipient32),
      router,
      'OutboundDomainPaused',
    );
    expect(await token.balanceOf(user.address)).to.equal(90n);
  });
});
