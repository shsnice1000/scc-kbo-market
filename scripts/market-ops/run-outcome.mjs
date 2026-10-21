// Partial success is healthy only for the explicitly configured subset.
// Unconfigured platforms remain blocked and do not turn a working subset into failure.
export function refreshExitCode(run) {
  if (!run || !Array.isArray(run.sources) || run.inputErrors?.length || run.state === "partial_failure" || run.sources.some((source) => source.state === "failed")) return 1;
  const completed = run.sources.some((source) => ["snapshot_imported", "snapshot_unchanged", "collector_updated", "collector_unchanged"].includes(source.state));
  return completed ? 0 : 2;
}
