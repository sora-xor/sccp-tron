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
