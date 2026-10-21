# Publication export bridge

The local market-operations database and the public Sites repository stay separate. The export bridge prepares a reviewed JSON draft under `.ops-private/publication-export/drafts/`; it never changes `site-source/data/`, its build output, or a deployment.

Start with `node scripts/market-ops.mjs publication-export-template`. The template is deliberately incomplete. Make a separate selection file under `.ops-private/publication-export/` and set the final review fields only after checking the permission evidence and every selected observation:

```json
{
  "schemaVersion": 1,
  "review": {
    "reviewerRole": "publisher",
    "reviewedAt": "2026-10-20T23:00:00Z",
    "publicationAllowed": true,
    "publicationBasis": "written_permission",
    "publicationEvidenceRef": "permission/basis-001",
    "noPersonalData": true
  },
  "observations": [
    {
      "listingKey": "bunjang:101",
      "matchCaseId": "private-match-case-001",
      "cardId": "public-card-id"
    }
  ]
}
```

The source permission ledger for every selected row must already allow display and history retention, remain unexpired, and match the selection's permission basis and evidence reference. The match queue must contain a current approved identity case for the same independent listing, and its copy-level identity must agree with the public card's printing identity. A queue approval is only an identity decision; its `publicPublicationAllowed: false` value is intentional. Owner-held and unknown-origin records, candidates without exact-copy evidence, expired rows, suppressed listings, and stale review hashes are rejected.

Verified-sale rows also need a private settlement evidence reference and `settlementEvidenceType` of `completed_order` or `payment_settlement` on that selection row. A sold badge cannot be elevated to a verified sale. Serial number, grade, condition, identity review, and evidence references remain in the private draft and approval ledger; only the derived comparison key enters public data.

Check eligibility without writing a draft:

```powershell
node scripts/market-ops.mjs publication-export .ops-private/publication-export/selection.json --dry-run
```

Create the content-addressed private draft after a successful dry run:

```powershell
node scripts/market-ops.mjs publication-export .ops-private/publication-export/selection.json
```

Review that file before separately importing it with `node scripts/import-reviewed-snapshot.mjs <draft-path> --dry-run`. The importer performs its own public data, source permission, and private-ledger checks. A non-dry-run import updates the Sites source/build files only; publishing or deploying the Site is a separate operation.

Each approved identity review receives a private random comparison-group UUID. Reuse that UUID only when a reviewer has confirmed that separate marketplace records show the same physical copy, including serial, grading, and condition. The UUID stays in the private queue and audit record. The public comparison key is derived from that random token and the reviewed identity, so it does not publish a guessable hash of a serial. `match-queue-list` shows the private group ID; `match-queue-decide <case-id> approve <evidence-ref> <comparison-group-uuid>` can assign an existing ID to a confirmed same-copy case. A fresh approval without an existing ID gets a new group, so records remain separate by default.

Each approved identity review receives a private random comparison-group UUID. Reuse that UUID only when a reviewer has confirmed that separate marketplace records show the same physical copy, including serial, grading, and condition. The UUID stays in the private queue and audit record. The public comparison key is derived from that random token and the reviewed identity, so it does not publish a guessable hash of a serial. `match-queue-list` shows the private group ID; `match-queue-decide <case-id> approve <evidence-ref> <comparison-group-uuid>` can assign an existing ID to a confirmed same-copy case. A fresh approval without an existing ID gets a new group, so records remain separate by default.
