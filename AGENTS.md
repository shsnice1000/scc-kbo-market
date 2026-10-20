# Public collaboration workspace

- This checkout is a development snapshot. Use synthetic fixtures; keep inventory, serials of owner-held cards, listing prices, photos, credentials and private source-review evidence outside Git.
- Preserve the distinction between asking prices, auction events and verified settlements. A sold badge never establishes a settlement price.
- Do not enable platform collection without verified access and storage/display permission. Do not bypass uploads or access controls.
- Do not deploy from this repository or replace an existing Sites remote/project ID. Its default hosting configuration is local development only.
- Make focused changes on branches and use Pull Requests. Run the relevant tests plus `npm run check` and `npm run check:public` before proposing a merge.
- Treat `site-source/data/market.json` as synthetic development data. Do not substitute private operating files or download seller photographs into this repository.
