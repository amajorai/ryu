#!/usr/bin/env node
// Generate standardized GitHub release notes for every channel (release /
// beta / nightly / canary).
//
// Before this, notes were a bare version string — nobody could tell what
// changed between two builds. This groups commits the way the wider GitHub
// ecosystem does (Features / Fixes / Performance / Docs / Other), credits
// external PR authors by @handle, and always states the exact commit the
// build came from.
//
//   node scripts/release-notes.mjs --tag v0.0.6 [--prev v0.0.5] [--channel release]
//
// Reads git history only — no network, no tokens — so it behaves identically
// in CI and locally.

import { execFileSync } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const tag = args.get("tag") || "";
const channel = args.get("channel") || "release";
const repo = args.get("repo") || "amajorai/ryu";
/** Commits authored by the project itself are not credited as contributors. */
const OWN = new Set(["ryu-mirror[bot]", "github-actions[bot]", "web-flow"]);

const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const head = git("rev-parse", "HEAD");
const shortHead = head.slice(0, 7);

/** Previous tag: explicit, else the most recent tag before HEAD, else the root. */
let prev = args.get("prev") || "";
if (!prev) {
  prev = git("describe", "--tags", "--abbrev=0", "--exclude", "canary", "--exclude", "nightly", `${head}^`);
}
const range = prev ? `${prev}..${head}` : head;

// %H|%s|%an|%ae — subject carries the conventional-commit type and any (#123).
const raw = git("log", range, "--no-merges", "--pretty=format:%H|%s|%an|%ae");
const commits = raw
  ? raw.split("\n").map((l) => {
      const [sha, subject, author, email] = l.split("|");
      return { sha, subject: subject ?? "", author: author ?? "", email: email ?? "" };
    })
  : [];

const SECTIONS = [
  ["feat", "### 🚀 Features"],
  ["fix", "### 🐛 Fixes"],
  ["perf", "### ⚡ Performance"],
  ["docs", "### 📚 Documentation"],
  ["other", "### 🧹 Other changes"],
];

const bucket = (subject) => {
  const m = /^(\w+)(\([^)]*\))?!?:/.exec(subject);
  const type = m ? m[1].toLowerCase() : "";
  if (type === "feat") return "feat";
  if (type === "fix") return "fix";
  if (type === "perf") return "perf";
  if (type === "docs") return "docs";
  return "other";
};

/** Strip the conventional prefix for display; keep the scope as context. */
const pretty = (subject) => {
  const m = /^(\w+)(\(([^)]*)\))?!?:\s*(.*)$/.exec(subject);
  if (!m) return subject;
  const scope = m[3] ? `**${m[3]}**: ` : "";
  return scope + m[4];
};

const groups = new Map(SECTIONS.map(([k]) => [k, []]));
const contributors = new Set();
let breaking = [];

for (const c of commits) {
  const prMatch = /\(#(\d+)\)\s*$/.exec(c.subject);
  const pr = prMatch ? prMatch[1] : null;
  // Credit a human author who is not the project's own automation.
  if (c.author && !OWN.has(c.author)) {
    const handle = /^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(c.email);
    if (handle) contributors.add(`@${handle[2]}`);
  }
  const link = pr
    ? `[#${pr}](https://github.com/${repo}/pull/${pr})`
    : `[\`${c.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${c.sha})`;
  const line = `- ${pretty(c.subject).replace(/\s*\(#\d+\)\s*$/, "")} (${link})`;
  if (/^\w+(\([^)]*\))?!:/.test(c.subject)) breaking.push(line);
  groups.get(bucket(c.subject)).push(line);
}

const out = [];
const title =
  channel === "canary"
    ? `Canary build \`${shortHead}\``
    : channel === "nightly"
      ? `Nightly build \`${shortHead}\``
      : `${tag}`;

out.push(`## ${title}`, "");

if (channel === "canary" || channel === "nightly") {
  out.push(
    `> Rolling **${channel}** build from \`main\` — not a stable release. Built from commit ` +
      `[\`${shortHead}\`](https://github.com/${repo}/commit/${head}).`,
    ""
  );
} else {
  out.push(`Built from commit [\`${shortHead}\`](https://github.com/${repo}/commit/${head}).`, "");
}

if (breaking.length) {
  out.push("### ⚠️ Breaking changes", "", ...breaking, "");
}

let any = false;
for (const [key, heading] of SECTIONS) {
  const list = groups.get(key);
  if (!list.length) continue;
  any = true;
  out.push(heading, "", ...list, "");
}
if (!any) out.push("_No code changes since the previous build._", "");

if (contributors.size) {
  out.push("### 🙌 Contributors", "", `Thanks to ${[...contributors].sort().join(", ")}.`, "");
}

if (prev) {
  out.push(`**Full changelog**: https://github.com/${repo}/compare/${prev}...${tag || shortHead}`);
}

process.stdout.write(`${out.join("\n")}\n`);
