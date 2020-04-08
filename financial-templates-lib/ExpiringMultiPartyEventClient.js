const { delay } = require("./delay");
const { Logger } = require("./logger/Logger");
const { LiquidationStatesEnum } = require("../common/Enums");

// A thick client for getting information about an ExpiringMultiParty events.
// This client is kept separate from the main ExpiringMultiPartyClient to keep
// a clear separation of concerns and to limit the overhead from querying chain necessarily.
// If no updateThreshold is specified then default to updating every 60 seconds.
class ExpiringMultiPartyEventClient {
  constructor(abi, web3, empAddress, updateThreshold = 60) {
    this.updateThreshold = updateThreshold;
    this.lastUpdateTimestamp;

    this.web3 = web3;

    // EMP contract
    this.emp = new web3.eth.Contract(abi, empAddress);
    this.empAddress = empAddress;

    // EMP Events
    this.liquidationEvents = [];
    this.disputeEvents = [];
    this.disputeSettlementEvents = [];
  }

  // Calls _update unless it was recently called, as determined by this.updateThreshold.
  update = async () => {
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime < this.lastUpdateTimestamp + this.updateThreshold) {
      Logger.debug({
        at: "ExpiringMultiPartyEventClient",
        message: "EMP state update skipped",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTimestamp,
        timeRemainingUntilUpdate: this.lastUpdateTimestamp + this.updateThreshold - currentTime
      });
      return;
    } else {
      await this._update();
      this.lastUpdateTimestamp = currentTime;
      Logger.debug({
        at: "ExpiringMultiPartyEventClient",
        message: "EMP state updated",
        lastUpdateTimestamp: this.lastUpdateTimestamp
      });
    }
  };

  // Force call of _update, designed to be called by downstream caller that knowingly updated the EMP state.
  forceUpdate = async () => {
    const currentTime = Math.floor(Date.now() / 1000);
    await this._update();
    this.lastUpdateTimestamp = currentTime;
    Logger.debug({
      at: "ExpiringMultiPartyEventClient",
      message: "EMP state force updated",
      lastUpdateTimestamp: this.lastUpdateTimestamp
    });
  };

  // Delete all events within the client
  clearState = async () => {
    this.liquidationEvents = [];
    this.disputeEvents = [];
    this.disputeSettlementEvents = [];
  };

  // Returns an array of liquidation events.
  getAllLiquidationEvents = () => this.liquidationEvents;

  // Returns an array of dispute events.
  getAllDisputeEvents = () => this.disputeEvents;

  // Returns an array of dispute events.
  getAllDisputeSettlementEvents = () => this.disputeSettlementEvents;

  start = () => {
    this._poll();
  };

  _poll = async () => {
    while (true) {
      try {
        await this._update();
      } catch (error) {
        Logger.error({
          at: "ExpiringMultiPartyEventClient",
          message: "client polling error",
          error: error
        });
      }
      await delay(Number(10_000));
    }
  };

  _update = async () => {
    //Events
    let liquidationBlockQueryNumber =
      this.liquidationEvents.length > 0 ? this.liquidationEvents[this.liquidationEvents.length - 1].blockNumber + 1 : 0;
    const liquidationEventsObj = await this.emp.getPastEvents("LiquidationCreated", {
      fromBlock: liquidationBlockQueryNumber
    });

    // If there have been previous events retrieve we should only query the chain for newer events.
    if (liquidationEventsObj.length !== 0) {
      for (let event of liquidationEventsObj) {
        this.liquidationEvents.push({
          transactionHash: event.transactionHash,
          sponsor: event.returnValues.sponsor,
          liquidator: event.returnValues.liquidator,
          liquidationId: event.returnValues.liquidationId,
          tokensOutstanding: event.returnValues.tokensOutstanding,
          lockedCollateral: event.returnValues.lockedCollateral,
          liquidatedCollateral: event.returnValues.liquidatedCollateral
        });
      }
    }

    let disputeBlockQueryNumber =
      this.disputeEvents.length > 0 ? this.disputeEvents[this.disputeEvents.length - 1].blockNumber + 1 : 0;
    const disputeEventsObj = await this.emp.getPastEvents("LiquidationDisputed", {
      fromBlock: disputeBlockQueryNumber
    });
    if (disputeEventsObj.length !== 0) {
      for (let event of disputeEventsObj) {
        this.disputeEvents.push({
          transactionHash: event.transactionHash,
          sponsor: event.returnValues.sponsor,
          liquidator: event.returnValues.liquidator,
          disputer: event.returnValues.disputer,
          liquidationId: event.returnValues.liquidationId,
          disputeBondAmount: event.returnValues.disputeBondAmount
        });
      }
    }

    let disputeSettlementBlockQueryNumber =
      this.disputeSettlementEvents.length > 0
        ? this.disputeSettlementEvents[this.disputeSettlementEvents.length - 1].blockNumber + 1
        : 0;
    const disputeSettlementEventsObj = await this.emp.getPastEvents("DisputeSettled", {
      fromBlock: disputeSettlementBlockQueryNumber
    });
    if (disputeSettlementEventsObj.length !== 0) {
      for (let event of disputeSettlementEventsObj) {
        this.disputeSettlementEvents.push({
          transactionHash: event.transactionHash,
          caller: event.returnValues.caller,
          sponsor: event.returnValues.sponsor,
          liquidator: event.returnValues.liquidator,
          disputer: event.returnValues.disputer,
          liquidationId: event.returnValues.liquidationId,
          disputeSucceeded: event.returnValues.DisputeSucceeded
        });
      }
    }

    Logger.debug({
      at: "ExpiringMultiPartyEventClient",
      message: "client updated"
    });
  };
}

module.exports = {
  ExpiringMultiPartyEventClient
};