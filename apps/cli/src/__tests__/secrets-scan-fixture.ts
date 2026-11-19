// Temporary git repositories and a fake Core detector for the
// `ryu-cli secrets scan --staged | --history | install-hook` tests.
//
// A git hook exports GIT_DIR, GIT_INDEX_FILE and friends. Inherited, they point
// fixture git commands at the real repository's index, so every git call here
// (and the CLI under test, through `env`) runs with them removed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNode, type NodeCall } from "./secrets-fixture.ts";

/** A credential-shaped value assembled at runtime so repository scanners
 *  never see it in source. */
export const LEAKED_VALUE = ["AKIA", "Q3EXAMPLE7RYUTST"].join("");
const SHAPE = /AKIA[0-9A-Z]{16}/g;

export interface TempRepo {
	dir: string;
	env: Record<string, string>;
	git: (...args: string[]) => string;
	remove: () => Promise<void>;
}

export function cleanGitEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) {
			env[key] = value;
		}
	}
	for (const marker of ["CLAUDECODE", "CURSOR_AGENT", "AGENT"]) {
		delete env[marker];
	}
	for (const key of Object.keys(env)) {
		if (key.startsWith("CODEX_") || key.startsWith("RYU_SECRETS_SCAN")) {
			delete env[key];
		}
	}
	return {
		...env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
}

export async function tempRepo(): Promise<TempRepo> {
	const root = await mkdtemp(join(tmpdir(), "ryu-scan-git-"));
	const dir = join(root, "repo");
	const env = cleanGitEnv(root);
	const git = (...args: string[]): string => {
		const run = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
		if (run.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
		}
		return run.stdout.trim();
	};
	spawnSync("git", ["init", "-q", "-b", "main", dir], { env });
	git("config", "commit.gpgsign", "false");
	return {
		dir,
		env,
		git,
		remove: () => rm(root, { recursive: true, force: true }),
	};
}

const scanBody = (call: NodeCall) =>
	JSON.parse(call.body) as { files: { content: string; path?: string }[] };

/** A Core whose scan route flags `AKIA…` shapes with a redacted preview, the
 *  way Core's detector reports them (line/column are 1-based). */
export function detectorNode() {
	return fakeNode({
		"POST /api/vault/scan": (call) => {
			const findings = scanBody(call).files.flatMap((file) =>
				file.content.split("\n").flatMap((text, index) =>
					[...text.matchAll(SHAPE)].map((match) => ({
						rule: "aws-access-key-id",
						description: "AWS access key id",
						source: file.path,
						line: index + 1,
						column: (match.index ?? 0) + 1,
						preview: `${match[0].slice(0, 4)}…${match[0].slice(-4)}`,
						fingerprint: createHash("sha256").update(match[0]).digest("hex"),
					}))
				)
			);
			return Response.json({ findings });
		},
	});
}

/** The files Core received across every scan request. */
export function scannedFiles(node: ReturnType<typeof fakeNode>) {
	return node.calls.flatMap((call) => scanBody(call).files);
}

/** A node whose transport fails the way a stopped Core does. */
export function unreachableNode() {
	const node = fakeNode({});
	node.target.fetch = () =>
		Promise.reject(
			new TypeError(
				"Unable to connect. Is the computer able to access the url?"
			)
		);
	return node;
}
