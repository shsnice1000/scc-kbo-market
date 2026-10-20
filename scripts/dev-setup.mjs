import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "site-source", ".openai");
const file = path.join(dir, "hosting.json");
await mkdir(dir, { recursive: true });
try {
  await writeFile(file, await readFile(path.join(dir, "hosting.example.json")), { flag: "wx" });
  console.log("Created ignored local development hosting configuration.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing local hosting configuration retained.");
}
