#!/usr/bin/env node
// Changelog for a public stable or ROLLING build, generated ON THE PUBLIC REPO
// with no access to private history.
//
//   node scripts/rolling-notes.mjs --tag v0.2.3 --channel release \
//     --prev v0.2.2 [--repo owner/name] [--require-ai]
//
// Why this can exist at all. The long-standing rule is that a changelog
// computed from this repo's history is meaningless, because that history is
// nothing but "mirror: sync from monorepo @ <sha>" commits. That is no longer
// the whole truth: each mirror commit's BODY now carries a written summary of
// what that sync contained (tools/ai-commit-message.mjs, in the private repo).
// So the material for a rolling changelog is already here — it just was not
// being read.
//
// A stable release produced by the private train can still use the richer,
// package-scoped generator in tools/ai-release-notes.mjs. This generator is the
// public-safe path for a direct public stable fallback, and remains the only
// path for canary/nightly releases because nothing fills those bodies later.
//
// With OPENCODE_API_KEY set as a repo secret the bodies are merged into a short
// Highlights section; without it they are concatenated as-is. Either way the
// content is real. Never fails the build: on any error it prints a minimal
// fallback and exits 0, because a rolling release with thin notes is better
// than a rolling release that did not publish. `--require-ai` changes that
// contract for a stable public release: missing credentials or a failed model
// call exits non-zero instead of silently shipping fallback notes.

import { execFileSync } from "node:child_process";
import { opencodeHeaders } from "./opencode-session.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const key = process.argv[i].replace(/^--/, "");
	const next = process.argv[i + 1];
	if (next === undefined || next.startsWith("--")) {
		args.set(key, true);
	} else {
		args.set(key, next);
		i++;
	}
}

const channel = args.get("channel") || "canary";
const repo = args.get("repo") || "amajorai/ryu";
const tag = typeof args.get("tag") === "string" ? args.get("tag") : "";
const requireAi = args.get("require-ai") === true;
const releaseKind =
	channel === "release" ? "stable release" : `rolling ${channel} build`;
const sessionContext = ["rolling-notes", repo, tag || "head", channel].join(
	":"
);

const git = (...a) => {
	try {
		return execFileSync("git", a, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
};

/**
 * Where the range starts: the previous build ON THIS CHANNEL, else the newest
 * stable tag. Both are real tags in this repo — rolling builds have carried
 * their own versioned tag since 2026-08-04, which is what makes "since the last
 * nightly" expressible at all.
 */
const pickPrev = () => {
	const tags = git("tag", "--list", "--sort=-v:refname")
		.split("\n")
		.filter(Boolean)
		.filter((candidate) => candidate !== tag);
	const sameChannel = tags.find((t) => t.includes(`-${channel}.`));
	if (sameChannel) {
		return sameChannel;
	}
	return tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t)) || "";
};

const prev =
	typeof args.get("prev") === "string" ? args.get("prev") : pickPrev();
const taggedHead = tag ? git("rev-parse", `${tag}^{commit}`) : "";
if (tag && !taggedHead) {
	process.stderr.write(`rolling-notes: tag does not resolve: ${tag}\n`);
	process.exit(1);
}
const head = taggedHead || git("rev-parse", "HEAD");
const range = prev ? `${prev}..${head}` : head;

const SEP = "\\x1e";
const entries = git("log", range, "--no-merges", `--pretty=format:${SEP}%s%n%b`)
	.split(SEP)
	.map((c) => c.trim())
	.filter(Boolean)
	.map((c) => {
		const nl = c.indexOf("\n");
		return {
			subject: nl === -1 ? c : c.slice(0, nl),
			body: nl === -1 ? "" : c.slice(nl + 1).trim(),
		};
	});

const emit = (lines) => {
	process.stdout.write(`${lines.filter((l) => l !== null).join("\n")}\n`);
	process.exit(0);
};

// A SATELLITE has no range to read: it is `git init` + force-push, so its whole
// history is one commit and every earlier tag points at an orphaned object. But
// that single commit's body is precisely the summary of this sync, so use it.
// The hub, which keeps real history, only reaches this when nothing changed.
if (!entries.length) {
	const body = git("log", "-1", "--pretty=%b").trim();
	if (!body) {
		emit([`_No changes since \`${prev || "the previous build"}\`._`]);
	}
	entries.push({ subject: git("log", "-1", "--pretty=%s"), body });
}

// Every bullet already written into the mirror commit bodies, in order. This is
// the no-key output and also the model's input.
const bullets = entries
	.flatMap((e) => e.body.split("\n"))
	.map((l) => l.trim())
	.filter((l) => l.startsWith("- "));

// With no resolvable previous tag — a satellite, or a first build — there is
// nothing to be "since" and no compare link that would resolve.
const heading = prev
	? `### Changes since \`${prev}\``
	: "### Changes in this build";
const compare = prev
	? `**Full changelog**: https://github.com/${repo}/compare/${prev}...${head}`
	: null;

const plain = () => {
	const lines = [heading, ""];
	// A rolling build can span many syncs; keep the body a sane length.
	lines.push(
		...(bullets.length
			? bullets.slice(0, 60)
			: entries.map((e) => `- ${e.subject}`))
	);
	if (bullets.length > 60) {
		lines.push("", `_${bullets.length - 60} further entries omitted._`);
	}
	if (compare) {
		lines.push("", compare);
	}
	return lines;
};

const fallback = (reason) => {
	if (requireAi) {
		process.stderr.write(`rolling-notes: ${reason}\n`);
		process.exit(1);
	}
	emit(plain());
};

const key = process.env.OPENCODE_API_KEY;
if (!key) {
	fallback("OPENCODE_API_KEY is not set");
}

try {
	const res = await fetch(
		`${process.env.OPENCODE_API_BASE || "https://opencode.ai/zen/go/v1"}/chat/completions`,
		{
			method: "POST",
			headers: opencodeHeaders(key, sessionContext),
			body: JSON.stringify({
				model: process.env.OPENCODE_MODEL || "mimo-v2.5",
				temperature: 0.2,
				max_tokens: Number(process.env.OPENCODE_MAX_TOKENS || 16_000),
				messages: [
					{
						role: "system",
						content: [
							`You write the notes for a ${releaseKind} of Ryu, a local-first agent platform.`,
							"Input is the set of change descriptions already written for the syncs in this range.",
							"Return STRICT JSON only — no prose, no markdown fence.",
							'Schema: {"highlights":[{"title":string,"body":string}],"bullets":[string]}',
							"",
							"Rules:",
							"- highlights: at most 3, only for user-visible new capability or a breaking change. title is a 3-6 word noun phrase; body is 2-3 sentences of plain prose. Empty array if nothing qualifies.",
							"- bullets: 5 to 20 one-line entries covering the rest, merged where they describe the same work, ordered by significance.",
							"- Never invent a change, package, number or API that is not in the input.",
							"- No marketing language, no emoji.",
						].join("\n"),
					},
					{
						role: "user",
						content: `Range: ${prev}..${head}\n\nChange descriptions:\n${JSON.stringify(
							bullets.length ? bullets.slice(0, 200) : entries,
							null,
							1
						)}`,
					},
				],
			}),
		}
	);
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	const json = await res.json();
	const text = json?.choices?.[0]?.message?.content;
	if (!text) {
		throw new Error("no content");
	}
	const parsed = JSON.parse(
		text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
	);
	if (!Array.isArray(parsed.bullets)) {
		throw new Error("no bullets");
	}
	const lines = [];
	for (const h of parsed.highlights || []) {
		if (!lines.length) {
			lines.push("## Highlights", "");
		}
		lines.push(`### ${h.title}`, "", String(h.body).trim(), "");
	}
	lines.push(heading, "");
	lines.push(...parsed.bullets.map((b) => `- ${String(b).trim()}`));
	if (compare) {
		lines.push("", compare);
	}
	emit(lines);
} catch (error) {
	// Any failure at all falls back to the real, unpolished bullets unless the
	// caller explicitly requires AI output for a stable release.
	fallback(error instanceof Error ? error.message : "AI generation failed");
}
