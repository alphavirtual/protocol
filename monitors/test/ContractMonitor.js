const { toWei } = web3.utils;
const winston = require("winston");
const sinon = require("sinon");

// Script to test
const { ContractMonitor } = require("../ContractMonitor");

// Helper client script
const { ExpiringMultiPartyEventClient } = require("../../financial-templates-lib/ExpiringMultiPartyEventClient");
const SpyTransport = require("../../financial-templates-lib/logger/SpyTransport");

// Truffle artifacts
const ExpiringMultiParty = artifacts.require("ExpiringMultiParty");
const Finder = artifacts.require("Finder");
const IdentifierWhitelist = artifacts.require("IdentifierWhitelist");
const MockOracle = artifacts.require("MockOracle");
const TokenFactory = artifacts.require("TokenFactory");
const Token = artifacts.require("ExpandedERC20");
const Timer = artifacts.require("Timer");

contract("ContractMonitor.js", function(accounts) {
  const tokenSponsor = accounts[0];
  const liquidator = accounts[1];
  const disputer = accounts[2];
  const sponsor1 = accounts[3];
  const sponsor2 = accounts[4];

  const zeroAddress = "0x0000000000000000000000000000000000000000";

  // Contracts
  let collateralToken;
  let collateralTokenSymbol;
  let emp;
  let syntheticToken;
  let mockOracle;
  let identifierWhitelist;

  // Test object for EMP event client
  let eventClient;

  // re-used variables
  let expirationTime;
  let constructorParams;

  const spy = sinon.spy();

  const spyLogIncludesValue = (spy, value) => {
    // sinon's getCall(n) function returns the values sent in in the nth call the the spy
    const lastReturnedArg = spy.getCall(-1).lastArg.mrkdwn.toString();
    return lastReturnedArg.indexOf(value) != -1;
  };

  before(async function() {
    collateralToken = await Token.new({ from: tokenSponsor });

    identifierWhitelist = await IdentifierWhitelist.deployed();
    await identifierWhitelist.addSupportedIdentifier(web3.utils.utf8ToHex("UMATEST"));

    // Create a mockOracle and finder. Register the mockOracle with the finder.
    mockOracle = await MockOracle.new(identifierWhitelist.address, Timer.address);
    finder = await Finder.deployed();
    const mockOracleInterfaceName = web3.utils.utf8ToHex("Oracle");
    await finder.changeImplementationAddress(mockOracleInterfaceName, mockOracle.address);
  });

  beforeEach(async function() {
    const currentTime = await mockOracle.getCurrentTime.call();
    expirationTime = currentTime.toNumber() + 100; // 100 seconds in the future

    constructorParams = {
      isTest: true,
      expirationTimestamp: expirationTime.toString(),
      withdrawalLiveness: "1000",
      collateralAddress: collateralToken.address,
      finderAddress: Finder.address,
      tokenFactoryAddress: TokenFactory.address,
      timerAddress: Timer.address,
      priceFeedIdentifier: web3.utils.utf8ToHex("UMATEST"),
      syntheticName: "Test UMA Token",
      syntheticSymbol: "UMATEST",
      liquidationLiveness: "10",
      collateralRequirement: { rawValue: toWei("1.5") },
      disputeBondPct: { rawValue: toWei("0.1") },
      sponsorDisputeRewardPct: { rawValue: toWei("0.1") },
      disputerDisputeRewardPct: { rawValue: toWei("0.1") },
      minSponsorTokens: { rawValue: toWei("1") }
    };

    // Create a sinon spy and give it to the SpyTransport as the winston logger. Use this to check all winston
    // logs the correct text based on interactions with the emp.

    const spyLogger = winston.createLogger({
      level: "info",
      transports: [new SpyTransport({ level: "info" }, { spy: spy })]
    });

    emp = await ExpiringMultiParty.new(constructorParams);
    eventClient = new ExpiringMultiPartyEventClient(spyLogger, ExpiringMultiParty.abi, web3, emp.address);
    contractMonitor = new ContractMonitor(spyLogger, eventClient, [accounts[0]], [accounts[1]]);

    syntheticToken = await Token.at(await emp.tokenCurrency());

    await collateralToken.addMember(1, tokenSponsor, {
      from: tokenSponsor
    });

    //   Bulk mint and approve for all wallets
    for (let i = 1; i < 5; i++) {
      await collateralToken.mint(accounts[i], toWei("100000000"), {
        from: tokenSponsor
      });
      await collateralToken.approve(emp.address, toWei("100000000"), {
        from: accounts[i]
      });
      await syntheticToken.approve(emp.address, toWei("100000000"), {
        from: accounts[i]
      });
    }

    // Create positions for the sponsors, liquidator and disputer
    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("50") }, { from: sponsor1 });
    await emp.create({ rawValue: toWei("175") }, { rawValue: toWei("45") }, { from: sponsor2 });
    await emp.create({ rawValue: toWei("1500") }, { rawValue: toWei("400") }, { from: liquidator });
    await emp.create({ rawValue: toWei("1500") }, { rawValue: toWei("399") }, { from: disputer });
  });

  it("Winston correctly emits liquidation message", async function() {
    // Create liquidation to liquidate sponsor2 from sponsor1
    const txObject1 = await emp.createLiquidation(
      sponsor1,
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      { from: liquidator }
    );

    // Update the eventClient and check it has the liquidation event stored correctly
    await eventClient._update();

    // Check for liquidation events
    await contractMonitor.checkForNewLiquidations(() => toWei("1"));

    // Ensure that the spy correctly captured the liquidation events key information.
    // Should contain etherscan addresses for the liquidator, sponsor and transaction
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${liquidator}`));
    assert.isTrue(spyLogIncludesValue(spy, "(Monitored liquidator bot)")); // The address that initiated the liquidation is a monitored address
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${sponsor1}`));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/tx/${txObject1.tx}`));

    // should contain the correct position information. Collateralization ratio for sponsor with 150 collateral and 50
    // debt with a price feed of 1 should give 150/(50 * 1) = 300%
    assert.isTrue(spyLogIncludesValue(spy, "300.00%")); // expected collateralization ratio of 300%
    assert.isTrue(spyLogIncludesValue(spy, "150.00")); // liquidated collateral amount of 150

    // Liquidate another position and ensure the Contract monitor emits the correct params
    const txObject2 = await emp.createLiquidation(
      sponsor2,
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      { from: sponsor1 } // not the monitored liquidator address
    );

    await eventClient._update();

    // check for new liquidations and check the winston messages sent to the spy
    await contractMonitor.checkForNewLiquidations(() => toWei("1"));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${sponsor1}`)); // liquidator in txObject2
    assert.isFalse(spyLogIncludesValue(spy, "(Monitored liquidator bot)")); // not called from a monitored address
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${sponsor2}`)); // token sponsor
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/tx/${txObject2.tx}`));
    assert.isTrue(spyLogIncludesValue(spy, "388.88%")); // expected collateralization ratio: 175 / (45 * 1) = 388.88%
    assert.isTrue(spyLogIncludesValue(spy, "175.00")); // liquidated collateral: 175
  });
  it("Winston correctly emits dispute events", async function() {
    // Create liquidation to dispute
    await emp.createLiquidation(
      sponsor1,
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      { from: liquidator }
    );

    const txObject = await emp.dispute("0", sponsor1, {
      from: disputer
    });

    // Update the eventClient and check it has the dispute event stored correctly
    await eventClient.clearState();
    await eventClient._update();

    await contractMonitor.checkForNewDisputeEvents(() => toWei("1"));

    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${disputer}`));
    assert.isTrue(spyLogIncludesValue(spy, "(Monitored dispute bot)"));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${liquidator}`));
    assert.isTrue(spyLogIncludesValue(spy, "(Monitored liquidator bot)"));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${sponsor2}`));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/tx/${txObject2.tx}`));
    assert.isTrue(spyLogIncludesValue(spy, "388.88%")); // collateralization ratio: 175 / (45 * 1) = 388.88%
    assert.isTrue(spyLogIncludesValue(spy, "15.00")); // dispute bond of 10% of sponsor 1's 150 collateral = 15
  });
  it("Return Dispute Settlement Events", async function() {
    // Create liquidation to liquidate sponsor2 from sponsor1
    const liquidationTime = (await emp.getCurrentTime()).toNumber();
    await emp.createLiquidation(
      sponsor1,
      { rawValue: toWei("99999") },
      { rawValue: toWei("100") },
      { from: liquidator }
    );

    // Dispute the position from the second sponsor
    await emp.dispute("0", sponsor1, {
      from: disputer
    });

    // Advance time and settle
    const timeAfterLiquidationLiveness = liquidationTime + 10;
    await mockOracle.setCurrentTime(timeAfterLiquidationLiveness.toString());
    await emp.setCurrentTime(timeAfterLiquidationLiveness.toString());

    // Force a price such that the dispute fails, and then withdraw from the unsuccessfully
    // disputed liquidation.
    const disputePrice = toWei("1.6");
    await mockOracle.pushPrice(web3.utils.utf8ToHex("UMATEST"), liquidationTime, disputePrice);

    const txObject = await emp.withdrawLiquidation("0", sponsor1, { from: liquidator });
    await eventClient.clearState();

    // Update the eventClient and check it has the dispute event stored correctly
    await eventClient._update();

    await contractMonitor.checkForNewDisputeSettlementEvents(() => toWei("1"));

    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${disputer}`));
    assert.isTrue(spyLogIncludesValue(spy, "(Monitored dispute bot)"));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${liquidator}`));
    assert.isTrue(spyLogIncludesValue(spy, "(Monitored liquidator bot)"));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/address/${sponsor2}`));
    assert.isTrue(spyLogIncludesValue(spy, `https://etherscan.io/tx/${txObject2.tx}`));
    assert.isTrue(spyLogIncludesValue(spy, "failed")); // the disputed was not successful based on settlement price
  });
});
