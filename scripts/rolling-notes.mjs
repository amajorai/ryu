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
import {
	batches,
	consolidateHighlights,
	modelHttpError,
	retryModelCall,
	reviewWithSplitting,
	validateCoverage,
} from "./notes-batches.mjs";
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
const tagArgument = args.get("tag");
const tag =
	tagArgument === true || tagArgument === undefined ? "" : tagArgument;
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
			maxBuffer: 64 * 1024 * 1024,
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
	const tags = git(
		"tag",
		"--merged",
		tag || "HEAD",
		"--list",
		"--sort=-v:refname"
	)
		.split("\n")
		.filter(Boolean)
		.filter((candidate) => candidate !== tag);
	const sameChannel = tags.find((t) => t.includes(`-${channel}.`));
	if (sameChannel) {
		return sameChannel;
	}
	return tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t)) || "";
};

const previousArgument = args.get("prev");
const prev =
	previousArgument === true || previousArgument === undefined
		? pickPrev()
		: previousArgument;
const taggedHead = tag ? git("rev-parse", `${tag}^{commit}`) : "";
if (tag && !taggedHead) {
	process.stderr.write(`rolling-notes: tag does not resolve: ${tag}\n`);
	process.exit(1);
}
const head = taggedHead || git("rev-parse", "HEAD");
if (prev && !git("rev-parse", `${prev}^{commit}`)) {
	process.stderr.write("rolling-notes: previous release does not resolve\n");
	process.exit(1);
}
const range = prev ? `${prev}..${head}` : head;

const SEP = "\\x1e";
const entries = execFileSync(
	"git",
	["log", range, `--pretty=format:${SEP}%s%n%b`],
	{
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}
)
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
	emit([`_No changes since \`${prev || "the previous build"}\`._`]);
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
		...(bullets.length ? bullets : entries.map((e) => `- ${e.subject}`))
	);
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

const request = async (messages) => {
	const res = await fetch(
		`${process.env.OPENCODE_API_BASE || "https://opencode.ai/zen/go/v1"}/chat/completions`,
		{
			method: "POST",
			signal: AbortSignal.timeout(180_000),
			headers: opencodeHeaders(key, sessionContext),
			body: JSON.stringify({
				model: process.env.OPENCODE_MODEL || "deepseek-v4.1-flash",
				temperature: 0.2,
				max_tokens: Number(process.env.OPENCODE_MAX_TOKENS || 16_000),
				messages,
			}),
		}
	);
	if (!res.ok) {
		throw modelHttpError(res, `HTTP ${res.status}`);
	}
	const json = await res.json();
	const choice = json?.choices?.[0];
	if (!choice?.message?.content || choice.finish_reason === "length") {
		throw new Error("Incomplete model output");
	}
	return JSON.parse(
		choice.message.content
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
	);
};
try {
	// Keep every mirror commit, including prose-only commits alongside bullet bodies.
	const descriptions = entries
		.flatMap((entry) => {
			const rows = entry.body
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("- "));
			return (rows.length ? rows : [entry.body || entry.subject]).map(
				(text) => ({ text, subject: entry.subject, context: entry.body })
			);
		})
		.map((description, index) => ({ id: String(index), ...description }));
	const work = batches(descriptions);
	const changes = [];
	let highlights = [];
	for (const [index, batch] of work.entries()) {
		process.stderr.write(
			`rolling-notes: batch ${index + 1}/${work.length}, ${batch.length} descriptions\n`
		);
		const result = await reviewWithSplitting(batch, (subset) =>
			retryModelCall(async () => {
				const value = await request([
					{
						role: "system",
						content: `Write notes for a ${releaseKind} of Ryu. Return strict JSON: {"highlights":[{"title":string,"body":string}],"changes":[{"id":string,"summary":string}]}. Return exactly one change per input id. Rewrite each description as one plain English sentence without dropping meaningful details. Highlights: at most 3, only user-visible capabilities or breaking changes. Never invent facts or use marketing language or emoji.`,
					},
					{ role: "user", content: JSON.stringify(subset) },
				]);
				validateCoverage(
					value.changes,
					subset.map((item) => item.id),
					(item) => item.id,
					(item) => item.summary
				);
				return value;
			})
		);
		changes.push(...result.changes);
		highlights.push(...(result.highlights || []));
	}
	highlights = await consolidateHighlights(
		highlights,
		(messages) => retryModelCall(() => request(messages)),
		3
	);
	validateCoverage(
		changes,
		descriptions.map((item) => item.id),
		(item) => item.id,
		(item) => item.summary
	);
	const byId = new Map(changes.map((item) => [item.id, item.summary]));
	const lines = [];
	if (highlights.length) {
		lines.push("## Highlights", "");
	}
	for (const h of highlights) {
		lines.push(`### ${h.title}`, "", h.body, "");
	}
	lines.push(
		heading,
		"",
		...descriptions.map((item) => `- ${byId.get(item.id)}`)
	);
	if (compare) {
		lines.push("", compare);
	}
	if (lines.join("\n").length > 120_000) {
		throw new Error("Complete notes exceed the release body limit");
	}
	process.stderr.write(
		`rolling-notes: verified ${changes.length}/${descriptions.length} descriptions\n`
	);
	emit(lines);
} catch (error) {
	fallback(error.message);
}
