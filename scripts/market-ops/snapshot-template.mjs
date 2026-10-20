import { SOURCE_BY_ID } from "./catalog.mjs";

export function buildSnapshotTemplate(sourceId, now = new Date()) {
  const source = SOURCE_BY_ID.get(sourceId);
  if (!source) throw new Error(`unknown source id: ${sourceId}`);
  const timestamp = now.toISOString();
  return {
    schemaVersion: 2,
    sourceId: source.id,
    sourceUrl: `https://${source.hostnames[0]}/`,
    captureMethod: "manual_public_page",
    review: {
      reviewerRole: "market_reviewer",
      reviewedAt: timestamp,
      publicationBasis: "written_permission",
      publicationEvidenceRef: "REPLACE_WITH_REAL_PRIVATE_PERMISSION_REF",
      publicationAllowed: false,
      termsReviewedAt: timestamp,
      historyStorageAllowed: false,
      retentionDays: 30,
      noPersonalData: true,
    },
    coverage: {
      scope: "REPLACE_WITH_SEARCH_QUERY_CATEGORY_BOARD_OR_LISTING_SCOPE",
      level: "point_check",
      pagesVisited: 0,
      stopReason: "unknown",
    },
    observations: [],
  };
}
