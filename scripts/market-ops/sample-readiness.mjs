import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIREMENTS = Object.freeze({
  officialIdentityGroups: 5,
  datedDirectSingleCardAsks: 10,
  exactCrossPlatformSerialPairs: 2,
  hardNegativeControls: 3,
  minimumPlatforms: 2,
  minimumTeams: 3,
  minimumCardTypes: 3,
});

const ZONED_ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DIRECT_CAPTURE_METHODS = new Set([
  "manual-browser-ui",
  "documented-direct-ui-history",
]);

async function readJson(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read sample evidence file ${path.basename(filePath)}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`sample evidence file ${path.basename(filePath)} must contain a JSON object`);
  }
  return parsed;
}

function hasDatedDirectEvidence(candidate, now, maxAgeMs) {
  if (candidate.evidenceLevel !== "direct-ui") return false;
  if (!candidate.sourceUrl || !candidate.observedAt || !ZONED_ISO_DATE.test(candidate.observedAt)) return false;
  if (!DIRECT_CAPTURE_METHODS.has(candidate.directObservation?.captureMethod)) return false;
  let url;
  const observedAt = Date.parse(candidate.observedAt);
  try {
    url = new URL(candidate.sourceUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && Number.isFinite(observedAt)
    && observedAt <= now
    && now - observedAt <= maxAgeMs;
}

function isSupportedNegativeControl(candidate, now, maxAgeMs) {
  return candidate.negativeControl === true
    && typeof candidate.candidateId === "string"
    && typeof candidate.matchStatus === "string"
    && candidate.matchStatus.startsWith("negative-control-")
    && hasDatedDirectEvidence(candidate, now, maxAgeMs);
}

function hasVerifiedChecklistRecord(checklist, now) {
  if (checklist?.status !== "verified"
    || checklist.product !== "2026 KBO LEAGUE SENSATION"
    || checklist.coverage !== "complete-player-card-category-matrix"
    || typeof checklist.checkedAt !== "string"
    || !ZONED_ISO_DATE.test(checklist.checkedAt)) return false;

  let sourceUrl;
  try {
    sourceUrl = new URL(checklist.sourceUrl);
  } catch {
    return false;
  }

  const checkedAt = Date.parse(checklist.checkedAt);
  return sourceUrl.protocol === "https:"
    && Number.isFinite(checkedAt)
    && checkedAt <= now;
}

function hasVerifiedMappingEvidence(sample, checklist, now) {
  const evidence = sample.mappingEvidence;
  if (sample.scopeStatus !== "official-checklist-mapped"
    || !/^SCC-26\/[A-Z]\d{2}$/.test(sample.officialCardId ?? "")
    || !evidence
    || evidence.sourceUrl !== checklist?.sourceUrl
    || evidence.rowReference !== sample.officialCardId
    || typeof evidence.verifiedAt !== "string"
    || !ZONED_ISO_DATE.test(evidence.verifiedAt)
    || typeof evidence.rowText !== "string"
    || !evidence.rowText.trim()
    || typeof evidence.identityBasis !== "string"
    || !evidence.identityBasis.trim()
    || typeof evidence.categoryBasis !== "string"
    || !evidence.categoryBasis.trim()) return false;

  const verifiedAt = Date.parse(evidence.verifiedAt);
  return Number.isFinite(verifiedAt) && verifiedAt <= now;
}

function normalizeFullSerial(serialText) {
  if (typeof serialText !== "string") return null;
  const match = /^\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*$/.exec(serialText);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator < 1
    || denominator < numerator) return null;
  return `${numerator}/${denominator}`;
}

function candidateFullSerial(candidate, candidatesById, now, maxAgeMs, allowImageLink) {
  const observedSerial = normalizeFullSerial(candidate.directObservation?.serialText);
  if (observedSerial) return observedSerial;
  if (!allowImageLink) return null;

  const evidence = candidate.serialIdentityEvidence;
  if (evidence?.method !== "identical-front-photo-to-serial-bearing-listing"
    || evidence.visualMatch !== "identical-photo"
    || typeof evidence.serialCandidateId !== "string"
    || typeof evidence.sourceUrl !== "string"
    || typeof evidence.serialText !== "string"
    || typeof evidence.manualReviewNote !== "string"
    || !evidence.manualReviewNote.trim()
    || typeof evidence.verifiedAt !== "string"
    || !ZONED_ISO_DATE.test(evidence.verifiedAt)) return null;

  const linkedCandidate = candidatesById.get(evidence.serialCandidateId);
  const linkedSerial = normalizeFullSerial(linkedCandidate?.directObservation?.serialText);
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const linkedObservedAt = Date.parse(linkedCandidate?.observedAt ?? "");
  if (!linkedCandidate
    || linkedCandidate.matchStatus !== "exact-cross-platform-serial"
    || linkedCandidate.crossPlatformPairId !== candidate.crossPlatformPairId
    || linkedCandidate.cardIdentityKey !== candidate.cardIdentityKey
    || linkedCandidate.platform === candidate.platform
    || linkedCandidate.sourceUrl !== evidence.sourceUrl
    || normalizeFullSerial(evidence.serialText) !== linkedSerial
    || !Number.isFinite(linkedObservedAt)
    || linkedObservedAt > verifiedAt
    || !Number.isFinite(verifiedAt)
    || verifiedAt > now
    || now - verifiedAt > maxAgeMs) return null;
  return linkedSerial;
}

function exactSerialPairCount(candidates, now, maxAgeMs, { allowImageLink = true } = {}) {
  const groups = new Map();
  const candidatesById = new Map(candidates
    .filter((candidate) => typeof candidate.candidateId === "string")
    .map((candidate) => [candidate.candidateId, candidate]));
  for (const candidate of candidates) {
    const pairId = candidate.crossPlatformPairId;
    if (!pairId || candidate.matchStatus !== "exact-cross-platform-serial") continue;
    const serial = candidateFullSerial(candidate, candidatesById, now, maxAgeMs, allowImageLink);
    if (!candidate.cardIdentityKey || !serial || typeof candidate.platform !== "string" || !candidate.platform.trim()) continue;
    if (Number.isInteger(candidate.serialNumber) && candidate.serialNumber !== Number(serial.split("/")[0])) continue;
    if (!hasDatedDirectEvidence(candidate, now, maxAgeMs)) continue;
    if (candidate.directObservation?.itemType !== "single_card" || candidate.priceType !== "asking") continue;
    if (!Number.isSafeInteger(candidate.directObservation.displayedAskPrivateKrw)
      || candidate.directObservation.displayedAskPrivateKrw <= 0) continue;
    const group = groups.get(pairId) ?? { identities: new Set(), serials: new Set(), platforms: new Set() };
    group.identities.add(candidate.cardIdentityKey);
    group.serials.add(serial);
    group.platforms.add(candidate.platform);
    groups.set(pairId, group);
  }
  return [...groups.values()].filter((group) =>
    group.identities.size === 1 && group.serials.size === 1 && group.platforms.size >= 2,
  ).length;
}

function summarizePriceRechecks(candidates, now, maxAgeMs) {
  let rechecks = 0;
  let askingPriceChanges = 0;
  for (const candidate of candidates) {
    if (candidate.priceType !== "asking"
      || candidate.directObservation?.itemType !== "single_card"
      || !hasDatedDirectEvidence(candidate, now, maxAgeMs)) continue;

    const firstAsk = candidate.directObservation.displayedAskPrivateKrw;
    if (!Number.isSafeInteger(firstAsk) || firstAsk <= 0) continue;
    const firstObservedAt = Date.parse(candidate.observedAt);
    const history = [{ observedAt: firstObservedAt, ask: firstAsk }];
    for (const recheck of candidate.priceRechecks ?? []) {
      if (recheck.priceType !== "asking"
        || recheck.marketStatus !== "active_at_direct_ui_check"
        || !DIRECT_CAPTURE_METHODS.has(recheck.captureMethod)
        || !recheck.observedAt
        || !ZONED_ISO_DATE.test(recheck.observedAt)
        || !Number.isSafeInteger(recheck.displayedAskPrivateKrw)
        || recheck.displayedAskPrivateKrw <= 0) continue;
      const observedAt = Date.parse(recheck.observedAt);
      if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) continue;
      if (observedAt <= firstObservedAt || history.some((entry) => entry.observedAt === observedAt)) continue;
      history.push({ observedAt, ask: recheck.displayedAskPrivateKrw });
    }
    history.sort((left, right) => left.observedAt - right.observedAt);
    rechecks += Math.max(0, history.length - 1);
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].ask !== history[index - 1].ask) askingPriceChanges += 1;
    }
  }
  return { rechecks, askingPriceChanges };
}

export async function buildSampleReadiness({ sampleDir, now = Date.now(), maxAgeDays = 7 }) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error("sample readiness time limits are invalid");
  }

  const [cards, markets, research] = await Promise.all([
    readJson(path.join(sampleDir, "card-reference-samples.json")),
    readJson(path.join(sampleDir, "market-candidate-samples.json")),
    readJson(path.join(sampleDir, "research-log.json")),
  ]);
  if (cards.publicPublicationAllowed !== false || markets.publicPublicationAllowed !== false) {
    throw new Error("sample files must explicitly prohibit public publication");
  }
  if (!Array.isArray(cards.samples) || !Array.isArray(markets.candidates)) {
    throw new Error("sample files are missing their samples or candidates arrays");
  }

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const directUiRecords = markets.candidates.filter((candidate) => candidate.evidenceLevel === "direct-ui");
  const datedDirectChecks = markets.candidates.filter((candidate) => hasDatedDirectEvidence(candidate, now, maxAgeMs));
  const datedSingleCardAsks = datedDirectChecks.filter((candidate) =>
    candidate.directObservation?.itemType === "single_card"
    && Number.isSafeInteger(candidate.directObservation.displayedAskPrivateKrw)
    && candidate.directObservation.displayedAskPrivateKrw > 0
    && candidate.priceType === "asking",
  );
  const checklist = research.officialChecklistStatus;
  const checklistVerified = hasVerifiedChecklistRecord(checklist, now);
  const mappedGroups = new Set(cards.samples
    .filter((sample) => hasVerifiedMappingEvidence(sample, checklist, now))
    .map((sample) => sample.officialCardId));
  const unsupportedOfficialMappings = cards.samples.filter((sample) =>
    sample.scopeStatus === "official-checklist-mapped"
    && !hasVerifiedMappingEvidence(sample, checklist, now),
  ).length;
  const negativeControls = new Set(markets.candidates
    .filter((candidate) => isSupportedNegativeControl(candidate, now, maxAgeMs))
    .map((candidate) => candidate.candidateId));
  const marketplaceSources = new Set(datedSingleCardAsks
    .map((candidate) => candidate.platform)
    .filter((platform) => typeof platform === "string" && platform.length > 0));
  const teams = new Set(datedSingleCardAsks
    .map((candidate) => candidate.directObservation?.teamText)
    .filter((team) => typeof team === "string" && team.trim().length > 0));
  const cardTypes = new Set(datedSingleCardAsks
    .map((candidate) => candidate.directObservation?.cardType)
    .filter((cardType) => typeof cardType === "string" && cardType.trim().length > 0));
  const exactPairs = exactSerialPairCount(markets.candidates, now, maxAgeMs);
  const directSerialPairs = exactSerialPairCount(markets.candidates, now, maxAgeMs, { allowImageLink: false });
  const priceRecheckSummary = summarizePriceRechecks(markets.candidates, now, maxAgeMs);

  const counts = {
    officialChecklist: checklistVerified ? 1 : 0,
    officialIdentityGroups: mappedGroups.size,
    officialMappingsMissingEvidence: unsupportedOfficialMappings,
    directUiRecordsWithUnsupportedCaptureMethod: directUiRecords.filter((candidate) =>
      !DIRECT_CAPTURE_METHODS.has(candidate.directObservation?.captureMethod),
    ).length,
    datedDirectChecks: datedDirectChecks.length,
    datedDirectSingleCardAsks: datedSingleCardAsks.length,
    marketplaceSources: marketplaceSources.size,
    teams: teams.size,
    cardTypes: cardTypes.size,
    exactCrossPlatformSerialPairs: exactPairs,
    exactCrossPlatformSerialPairsWithSerialTextOnBothPages: directSerialPairs,
    hardNegativeControls: negativeControls.size,
    repeatListingRechecks: priceRecheckSummary.rechecks,
    askingPriceChanges: priceRecheckSummary.askingPriceChanges,
    privateOnly: true,
  };

  const blockers = [];
  if (!checklistVerified) blockers.push("공식 2026 SCC 체크리스트 확인 필요");
  if (counts.officialIdentityGroups < REQUIREMENTS.officialIdentityGroups) {
    blockers.push(`공식 매핑 카드 식별군 ${REQUIREMENTS.officialIdentityGroups}개 필요`);
  }
  if (counts.datedDirectSingleCardAsks < REQUIREMENTS.datedDirectSingleCardAsks) {
    blockers.push(`최근 ${maxAgeDays}일 내 URL·시각이 있는 단품 호가 관측 ${REQUIREMENTS.datedDirectSingleCardAsks}건 필요`);
  }
  if (counts.marketplaceSources < REQUIREMENTS.minimumPlatforms) {
    blockers.push(`단품 매물 출처 ${REQUIREMENTS.minimumPlatforms}곳 필요`);
  }
  if (counts.teams < REQUIREMENTS.minimumTeams) blockers.push(`서로 다른 구단 ${REQUIREMENTS.minimumTeams}곳 필요`);
  if (counts.cardTypes < REQUIREMENTS.minimumCardTypes) blockers.push(`서로 다른 카드 유형 ${REQUIREMENTS.minimumCardTypes}종 필요`);
  if (exactPairs < REQUIREMENTS.exactCrossPlatformSerialPairs) {
    blockers.push(`동일 실물 시리얼의 교차 플랫폼 쌍 ${REQUIREMENTS.exactCrossPlatformSerialPairs}개 필요`);
  }
  if (negativeControls.size < REQUIREMENTS.hardNegativeControls) {
    blockers.push(`근거가 있는 음성 대조군 ${REQUIREMENTS.hardNegativeControls}개 필요`);
  }

  return {
    ready: blockers.length === 0,
    requirements: REQUIREMENTS,
    counts,
    blockers,
    publicationAllowed: false,
  };
}

export function formatSampleReadiness(report) {
  const { counts, requirements } = report;
  const lines = [
    "SCC sample evidence readiness (private local files only)",
    `Official checklist: ${counts.officialChecklist}/1`,
    `Officially mapped card identity groups: ${counts.officialIdentityGroups}/${requirements.officialIdentityGroups}`,
    `Official mappings missing row evidence: ${counts.officialMappingsMissingEvidence}`,
    `Direct UI records with unsupported capture method: ${counts.directUiRecordsWithUnsupportedCaptureMethod}`,
    `Dated direct single-card asking observations: ${counts.datedDirectSingleCardAsks}/${requirements.datedDirectSingleCardAsks}`,
    `Marketplace sources represented: ${counts.marketplaceSources}/${requirements.minimumPlatforms}`,
    `Teams represented: ${counts.teams}/${requirements.minimumTeams}`,
    `Card types represented: ${counts.cardTypes}/${requirements.minimumCardTypes}`,
    `Exact same-card, same full serial cross-platform pairs (direct serial or identical-photo link): ${counts.exactCrossPlatformSerialPairs}/${requirements.exactCrossPlatformSerialPairs}`,
    `Pairs with direct serial text on both platform pages: ${counts.exactCrossPlatformSerialPairsWithSerialTextOnBothPages}`,
    `Supported hard-negative controls: ${counts.hardNegativeControls}/${requirements.hardNegativeControls}`,
    `Repeated direct listing rechecks: ${counts.repeatListingRechecks}`,
    `Asking-price changes between recorded checks: ${counts.askingPriceChanges}`,
    `Dated direct listing records (all item types): ${counts.datedDirectChecks}`,
    `Sample gate: ${report.ready ? "READY FOR MVP SAMPLE REVIEW" : "BLOCKED"}`,
    `Public publication: ${report.publicationAllowed ? "allowed" : "not allowed"}`,
  ];
  if (report.blockers.length) lines.push(`Remaining evidence: ${report.blockers.join("; ")}`);
  return lines.join("\n");
}
