'use strict';

const {isDeepStrictEqual} = require('node:util');

const legacyPolicy = Object.freeze({
  version: 'ER-CANCELLATION-2026-1',
  summary: 'Fees are based on the accepted reservation fare. Time before pickup is measured in elapsed hours. Eligible refunds return to the original payment method.',
  tiers: Object.freeze([
    Object.freeze({minimumHours: 24, feePercent: 0, verification: false, text: 'At least 24 hours before pickup — 0% fee. Full eligible refund.'}),
    Object.freeze({minimumHours: 2, feePercent: 10, verification: false, text: 'At least 2 hours but less than 24 hours before pickup — 10% fee.'}),
    Object.freeze({minimumHours: 0, feePercent: 25, verification: false, text: 'Less than 2 hours before pickup — 25% fee.'}),
    Object.freeze({minimumHours: null, feePercent: 50, verification: true, text: 'At or after pickup — 50% fee only after authorized verification that pickup and service did not occur.'})
  ])
});

const currentPolicy = Object.freeze({
  version: 'ER-CANCELLATION-24H-2026-1',
  summary: 'Cancellation timing uses elapsed hours before your New York pickup time. Eligible refunds return to the original payment method.',
  tiers: Object.freeze([
    Object.freeze({text: 'At least 24 hours before pickup: confirm your cancellation online with no cancellation fee. Eligible paid reservations receive a full refund of the remaining refundable payment. Unpaid reservations are cancelled without a refund.'}),
    Object.freeze({text: 'Less than 24 hours before pickup: request cancellation for owner review. Your reservation remains active until approval. Refunds require a separate owner decision. No automatic cancellation fee applies.'}),
    Object.freeze({text: 'Started or completed trips require authorized owner review and cannot be cancelled automatically.'})
  ])
});

// The retired proposal remains readable only as historical acceptance evidence.
// Its fees never participate in the current cancellation calculation.
const versions = new Map([[currentPolicy.version, currentPolicy], [legacyPolicy.version, legacyPolicy]]);
const CONSENT_REQUIRED = 'Review and accept the current cancellation and refund policy before reserving.';

function requireConsent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, 'version') || !Object.hasOwn(input, 'accepted') ||
      input.version !== currentPolicy.version || input.accepted !== true) {
    throw Object.assign(new Error(CONSENT_REQUIRED), {status: 400});
  }
}

function acceptedPolicy(record) {
  const evidence = record.cancellationPolicyAcceptance;
  const approved = versions.get(evidence?.policy?.version);
  if (!approved || !isDeepStrictEqual(evidence.policy, approved) ||
      !Object.hasOwn(evidence, 'acceptedAt') || Object.keys(evidence).length !== 2 ||
      evidence.acceptedAt !== record.createdAt) return null;
  return evidence;
}

module.exports = {currentPolicy, CONSENT_REQUIRED, requireConsent, acceptedPolicy};
