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
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, "");
  const next = process.argv[i + 1];
  // Bare flags (--no-commit-links) carry no value; keyed options consume one.
  if (next === undefined || next.startsWith("--")) {
    args.set(key, true);
  } else {
    args.set(key, next);
    i++;
  }
}

const tag = args.get("tag") || "";
const channel = args.get("channel") || "release";
const repo = args.get("repo") || "amajorai/ryu";
// When notes are generated from the PRIVATE monorepo, the shas are private and
// linking them into the public repo yields 404s for every reader. The grouped
// changelog is the valuable part, so render bare shas instead.
const noCommitLinks = args.get("no-commit-links") === true;
// CI runs this ON the mirror, whose history is only "mirror: sync from monorepo
// @ <sha>" commits — a changelog computed there is noise. CI seeds the release
// with the Install block only; tools/publish-release-notes.sh fills in the real
// changelog afterwards from this repo's history.
const noChangelog = args.get("no-changelog") === true;
const commitRef = (sha, short) =>
  noCommitLinks
    ? `\`${short}\``
    : `[\`${short}\`](https://github.com/${repo}/commit/${sha})`;
/** Commits authored by the project itself are not credited as contributors. */
const OWN = new Set(["ryu-mirror[bot]", "github-actions[bot]", "web-flow"]);

const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// End of the range. In CI this runs at the tagged commit, so HEAD and the tag
// agree — but run from a maintainer's checkout for an OLDER tag (which is how
// tools/publish-release-notes.sh repairs a release) HEAD is whatever main is
// now, and the notes would list every commit landed since. Prefer the tag when
// it resolves locally.
const tagRef = args.get("tag") || "";
const head = (tagRef && git("rev-parse", `${tagRef}^{commit}`)) || git("rev-parse", "HEAD");
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
  ["feat", "### Features"],
  ["fix", "### Fixes"],
  ["perf", "### Performance"],
  ["docs", "### Documentation"],
  ["other", "### Other changes"],
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
    : commitRef(c.sha, c.sha.slice(0, 7));
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

// GitHub already shows the tag + title on the release card, so repeating it
// here is pure noise. Rolling channels still need a line saying WHICH build
// this is, since their tag is just "canary"/"nightly".
if (channel === "canary" || channel === "nightly") {
  out.push(`## ${title}`, "");
}

if (channel === "canary" || channel === "nightly") {
  out.push(
    `> Rolling **${channel}** build from \`main\` — not a stable release. Built from commit ` +
      `${commitRef(head, shortHead)}.`,
    ""
  );
} else {
  out.push(`Built from commit ${commitRef(head, shortHead)}.`, "");
}

// Install block sits at the TOP, before the changelog: most people landing on a
// release want the download, not the diff. Desktop first because that is what
// most people want; the headless stack second for devs and self-hosters.
if (channel === "release" || channel === "beta") {
  out.push(
    "### Install",
    "",
    "**Most people — the desktop app.** Download the installer for your OS from the assets below, or from https://ryuhq.com/download.",
    "",
    "| macOS | Windows | Linux |",
    "|---|---|---|",
    "| `.dmg` (Apple Silicon) | `.msi` / `.exe` | `.AppImage` / `.deb` |",
    "",
    "**Developers, self-hosters, servers — the headless stack** (`ryu-core`, `ryu-gateway`, `ryu-cli`) into `~/.ryu/bin`:",
    "",
    "```bash",
    "# macOS / Linux",
    "curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh",
    "```",
    "",
    "```powershell",
    "# Windows (PowerShell)",
    "irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex",
    "```",
    "",
    "Then `ryu-cli` — it starts a local Core on first run, no API key needed. Individual binaries are attached below with `.sha256` checksums.",
    ""
  );
}

if (noChangelog) {
  out.push("_Changelog is being generated._", "");
} else {
  if (breaking.length) {
    out.push("### Breaking changes", "", ...breaking, "");
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
    out.push("### Contributors", "", `Thanks to ${[...contributors].sort().join(", ")}.`, "");
  }
}

if (prev && !noChangelog) {
  out.push(`**Full changelog**: https://github.com/${repo}/compare/${prev}...${tag || shortHead}`);
}

process.stdout.write(`${out.join("\n")}\n`);
