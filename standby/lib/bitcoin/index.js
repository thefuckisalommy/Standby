'use strict';

// Bitcoin: transaction parsing, dry runs, broadcasts, node reads. Node
// built-ins only. This file gathers the parts in this folder; the rest of
// the app requires './bitcoin' and uses them from here.
// Nodes are two endpoints, each a mempool API or Bitcoin Core RPC
// (lib/rpc.js), tried in order; a blank secondary means primary only.
// A completed check is definitive (a spent input is a chain fact); only a
// failed check falls through to the next endpoint.
// Hard rules: never accept, store or log wallet keys or seeds (an RPC
// login is stored for the node, never served or logged); the
// stored signed hex reveals destinations and amounts, so only a short
// preview is ever logged; a broadcast is irrevocable and only the release
// evaluation may trigger one.

const tx = require('./tx');
const nodes = require('./nodes');
const fees = require('./fees');
const prices = require('./prices');
const broadcast = require('./broadcast');
const outspends = require('./outspends');
const dryrun = require('./dryrun');
const nodetest = require('./nodetest');

module.exports = {
  parseTx: tx.parseTx,
  extractTxFromPsbt: tx.extractTxFromPsbt,
  checkInputsUnspent: outspends.checkInputsUnspent,
  checkOutspend: outspends.checkOutspend,
  checkOutspends: outspends.checkOutspends,
  createOutspendBatch: outspends.createOutspendBatch,
  dryRun: dryrun.dryRun,
  broadcastTx: broadcast.broadcastTx,
  testConnection: nodetest.testConnection,
  getConfirmations: nodes.getConfirmations,
  getTipHeight: nodes.getTipHeight,
  findSharedInputs: tx.findSharedInputs,
  isArchivedTx: tx.isArchivedTx,
  timelockedUntil: tx.timelockedUntil,
  computeFee: dryrun.computeFee,
  txIoDetail: tx.txIoDetail,
  scriptPubKeyInfo: tx.scriptPubKeyInfo,
  broadcastViaSlipstream: broadcast.broadcastViaSlipstream,
  getSlipstreamTxStatus: broadcast.getSlipstreamTxStatus,
  feePeakFromObservations: fees.feePeakFromObservations,
  appendFeeHistoryObservation: fees.appendFeeHistoryObservation,
  feeEstimatesToRecommended: fees.feeEstimatesToRecommended,
  feeEstimateAtTarget: fees.feeEstimateAtTarget,
  ESPLORA_FEE_TARGETS: nodes.ESPLORA_FEE_TARGETS,
  fetchCurrentFeesFromNode: fees.fetchCurrentFeesFromNode,
  fetchCurrentFeesFromEndpoints: fees.fetchCurrentFeesFromEndpoints,
  feeVerdict: fees.feeVerdict,
  priceApiBase: prices.priceApiBase,
  DEFAULT_PRICE_API_URL: prices.DEFAULT_PRICE_API_URL,
  PRICE_PROVIDERS: prices.PRICE_PROVIDERS,
  priceProviderById: prices.priceProviderById,
  priceProviderLabel: prices.priceProviderLabel,
  fetchPriceFromProvider: prices.fetchPriceFromProvider,
  PRICE_USER_AGENT: prices.PRICE_USER_AGENT,
  fetchPriceReadings: prices.fetchPriceReadings,
  combinePriceReadings: prices.combinePriceReadings,
  priceConsensus: prices.priceConsensus,
  parseJsonPath: prices.parseJsonPath,
  priceFromPath: prices.priceFromPath,
  customPriceProvider: prices.customPriceProvider,
  normalizePriceSourceValue: prices.normalizePriceSourceValue,
  priceSourceKey: prices.priceSourceKey,
  resolvePriceSource: prices.resolvePriceSource,
  fetchNodeFee: fees.fetchNodeFee,
  fetchNodeFeeReadings: fees.fetchNodeFeeReadings,
  combineFeeReadings: fees.combineFeeReadings,
  FEE_IMPLAUSIBLE_SATVB: fees.FEE_IMPLAUSIBLE_SATVB,
  fetchTipHeights: nodes.fetchTipHeights,
  combineTipHeights: nodes.combineTipHeights,
  normalizePublicApiUrl: nodes.normalizePublicApiUrl,
  mempoolBase: nodes.mempoolBase,
  endpointsFor: nodes.endpointsFor,
  nodeBases: nodes.nodeBases,
  nodeCheckedAt: nodes.nodeCheckedAt,
  clearOutspendCache: outspends.clearOutspendCache,
  DEFAULT_PUBLIC_API_URL: nodes.DEFAULT_PUBLIC_API_URL,
  DEFAULT_SECONDARY_API_URL: nodes.DEFAULT_SECONDARY_API_URL,
  DEFAULT_SLIPSTREAM_API_URL: broadcast.DEFAULT_SLIPSTREAM_API_URL,
};
