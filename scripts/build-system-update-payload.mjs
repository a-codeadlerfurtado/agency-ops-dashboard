import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sha = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const subject = execFileSync("git", ["show", "-s", "--format=%s", sha], { encoding: "utf8" }).trim();
const body = execFileSync("git", ["show", "-s", "--format=%b", sha], { encoding: "utf8" }).trim();
const committedAt = execFileSync("git", ["show", "-s", "--format=%cI", sha], { encoding: "utf8" }).trim();

const nameStatus = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", sha], { encoding: "utf8" }).trim();
const numstat = execFileSync("git", ["show", "--numstat", "--format=", sha], { encoding: "utf8" }).trim();
const stats = new Map();
for (const line of numstat.split("\n").filter(Boolean)) {
  const [a, d, ...rest] = line.split("\t");
  const path = rest.join("\t");
  stats.set(path, {
    additions: a === "-" ? 0 : Number(a || 0),
    deletions: d === "-" ? 0 : Number(d || 0),
  });
}

const files = nameStatus.split("\n").filter(Boolean).map((line) => {
  const parts = line.split("\t");
  const status = parts[0] || "M";
  const path = parts.at(-1) || "";
  const stat = stats.get(path) || { additions: 0, deletions: 0 };
  return { path, status, ...stat };
});

const payload = { sha, subject, body, committed_at: committedAt, files };
const output = process.argv[2] || "/tmp/system-update-payload.json";
writeFileSync(output, JSON.stringify(payload));
console.log(`Prepared system-update payload for ${sha.slice(0, 7)} with ${files.length} files.`);
