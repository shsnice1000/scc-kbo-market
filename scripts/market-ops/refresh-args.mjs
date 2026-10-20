import path from "node:path";

export function parseRefreshArgs(args) {
  const files = [];
  let bunjangConfigPath = null;
  let inbox = false;
  let scheduled = false;
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--scheduled") {
      if (scheduled) throw new Error("refresh accepts --scheduled only once");
      scheduled = true;
      continue;
    }
    if (argument === "--inbox") {
      if (inbox) throw new Error("refresh accepts --inbox only once");
      inbox = true;
      continue;
    }
    if (argument === "--snapshot") {
      const file = args[i + 1];
      if (!file || file.startsWith("--")) throw new Error("--snapshot requires a file path");
      files.push(path.resolve(file));
      i += 1;
      continue;
    }
    if (argument === "--bunjang-config") {
      const file = args[i + 1];
      if (!file || file.startsWith("--")) throw new Error("--bunjang-config requires a private config path");
      if (bunjangConfigPath) throw new Error("refresh accepts one --bunjang-config path");
      bunjangConfigPath = file;
      i += 1;
      continue;
    }
    throw new Error("refresh accepts repeated --snapshot <file>, one --bunjang-config <private-config.json>, or --inbox; --scheduled may be added for a real scheduler invocation");
  }
  if (inbox && (files.length || bunjangConfigPath)) throw new Error("refresh --inbox cannot be combined with --snapshot or --bunjang-config");
  return { snapshotFiles: files, bunjangConfigPath, inbox, runOrigin: scheduled ? "scheduled" : "manual" };
}
