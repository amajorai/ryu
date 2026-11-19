import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { rekeyLine, rekeyShape } from "../cli/secrets-rekey.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const STATUS = {
	started: true,
	nonce: "n-1",
	required: 3,
	progress: 1,
	newShares: 5,
	newThreshold: 3,
};
const IDLE = {
	...STATUS,
	started: false,
	nonce: null,
	progress: 0,
	startedAt: null,
};
const NEW_SHARES = ["new-a", "new-b", "new-c", "new-d", "new-e"];

function rekeyNode(complete = false) {
	return fakeNode({
		"GET /api/vault/sys/rekey": json({ rekey: STATUS }),
		"POST /api/vault/sys/rekey/init": (call) =>
			Response.json({
				rekey: { ...STATUS, ...JSON.parse(call.body), progress: 0 },
			}),
		"POST /api/vault/sys/rekey/cancel": json({ rekey: IDLE }),
		"POST /api/vault/sys/rekey/update": () =>
			Response.json(
				complete
					? { complete: true, status: IDLE, shares: NEW_SHARES }
					: { complete: false, status: { ...STATUS, progress: 2 } }
			),
	});
}

function body(node: ReturnType<typeof rekeyNode>, route: string) {
	return JSON.parse(
		node.calls.find((call) => call.route === route)?.body ?? "{}"
	);
}

describe("ryu-cli secrets rekey", () => {
	test("status, init and cancel", async () => {
		const node = rekeyNode();
		expect((await runSecrets(["rekey"], node)).out).toContain(
			"1/3 current shares submitted"
		);
		const init = await runSecrets(
			["rekey", "init", "--shares", "7", "--threshold", "4"],
			node
		);
		expect(init.code).toBe(0);
		expect(body(node, "POST /api/vault/sys/rekey/init")).toEqual({
			shares: 7,
			threshold: 4,
		});
		expect((await runSecrets(["rekey", "cancel"], node)).out).toContain(
			"No rekey is in progress."
		);
		for (const flags of [
			["--shares", "2", "--threshold", "3"],
			["--shares", "256"],
			["--threshold", "0"],
		]) {
			expect(
				(await runSecrets(["rekey", "init", ...flags], node)).code
			).not.toBe(0);
		}
	});

	test("update reads the share from stdin, never an argument, and uses the live nonce", async () => {
		const node = rekeyNode();
		const pending = await runSecrets(["rekey", "update"], node, {
			readStdin: () => Promise.resolve("old-share\n"),
		});
		expect(pending.code).toBe(0);
		expect(pending.out).toContain("2/3");
		expect(body(node, "POST /api/vault/sys/rekey/update")).toEqual({
			nonce: "n-1",
			share: "old-share",
		});
		const terminal = await runSecrets(["rekey", "update"], node, {
			readStdin: () => Promise.resolve(null),
		});
		expect(terminal.code).not.toBe(0);
		expect(terminal.err).toContain("stdin");
		// A share passed as an argument is refused, even with stdin piped too.
		const before = node.calls.length;
		const argv = await runSecrets(["rekey", "update", "old-share"], node, {
			readStdin: () => Promise.resolve("old-share"),
		});
		expect(argv.code).not.toBe(0);
		expect(argv.err).toContain("never takes a share as an argument");
		// After `--` the share lands in the passthrough, never in positionals.
		const dashed = await runSecrets(
			["rekey", "update", "--", "rks1-share"],
			node,
			{
				readStdin: () => Promise.resolve("old-share"),
			}
		);
		expect(dashed.code).not.toBe(0);
		expect(dashed.err).toContain("never takes a share as an argument");
		expect(
			node.calls.slice(before).some((call) => call.route.endsWith("/update"))
		).toBe(false);
		expect(
			node.calls.slice(before).some((call) => call.route.endsWith("/update"))
		).toBe(false);
	});

	test("the completing update prints the new shares once, with a warning on stderr", async () => {
		const node = rekeyNode(true);
		const done = await runSecrets(["rekey", "update", "--nonce", "n-1"], node, {
			readStdin: () => Promise.resolve("last-share"),
		});
		expect(done.code).toBe(0);
		expect(done.out.trim().split("\n")).toEqual(NEW_SHARES);
		expect(done.err).toContain("not shown again");
		expect(done.err).not.toContain("new-a");
		const json = await runSecrets(
			["rekey", "update", "--json"],
			rekeyNode(true),
			{
				readStdin: () => Promise.resolve("last-share"),
			}
		);
		expect(JSON.parse(json.out).shares).toEqual(NEW_SHARES);
		expect(json.err).toContain("not shown again");
		expect(json.err).not.toContain("new-a");
	});

	test("update is refused in an AI agent session before any share is sent", async () => {
		const node = rekeyNode(true);
		const agent = {
			env: { HOME: "/home/me", CLAUDECODE: "1" },
			promptLine: () => Promise.resolve(null),
			readStdin: () => Promise.resolve("old-share"),
		};
		for (const argv of [
			["rekey", "update"],
			["rekey", "--json", "update"],
			["rekey", "update", "--human"],
		]) {
			const refused = await runSecrets(argv, node, agent);
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain("new-a");
		}
		expect(node.calls.some((call) => call.route.endsWith("/update"))).toBe(
			false
		);
		// Starting or cancelling someone's rekey is refused too, whatever the
		// flag order: cancelling discards the share holders' progress.
		for (const argv of [
			["rekey", "init"],
			["rekey", "cancel"],
			["rekey", "--json", "init", "--shares", "5"],
			["rekey", "cancel", "--json"],
		]) {
			const refused = await runSecrets(argv, node, agent);
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain("key share holders");
		}
		expect(
			node.calls.some(
				(call) => call.route.endsWith("/init") || call.route.endsWith("/cancel")
			)
		).toBe(false);
		expect((await runSecrets(["rekey", "status"], node, agent)).code).toBe(0);
	});

	test("rekeyShape and rekeyLine", () => {
		expect(rekeyShape(parseSecretsArgs(["rekey", "init"]))).toEqual({});
		expect(rekeyLine({ ...IDLE, nonce: null })).toBe(
			"No rekey is in progress."
		);
		expect(rekeyLine(STATUS)).toContain("Nonce: n-1");
	});

	test("--out keeps the new shares in an owner-only file, checked before the share is sent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ryu-rekey-test-"));
		try {
			const stdin = { readStdin: () => Promise.resolve("last-share") };
			const existing = join(dir, "shares.txt");
			await writeFile(existing, "keep");
			const node = rekeyNode(true);
			const refused = await runSecrets(
				["rekey", "update", "--out", existing],
				node,
				stdin
			);
			expect(refused.code).not.toBe(0);
			expect(node.calls.some((call) => call.route.endsWith("/update"))).toBe(
				false
			);
			expect(await readFile(existing, "utf8")).toBe("keep");

			const fresh = join(dir, "new-shares.txt");
			const written = await runSecrets(
				["rekey", "update", "--out", fresh],
				node,
				stdin
			);
			expect(written.code).toBe(0);
			expect(written.out).not.toContain("new-a");
			expect((await readFile(fresh, "utf8")).trim().split("\n")).toEqual(
				NEW_SHARES
			);
			expect((await stat(fresh)).mode & 0o777).toBe(0o600);

			// A missing folder is refused before the share is sent.
			const missing = join(dir, "no-such-dir", "shares.txt");
			const before = node.calls.length;
			const refusedEarly = await runSecrets(
				["rekey", "update", "--out", missing],
				node,
				stdin
			);
			expect(refusedEarly.code).not.toBe(0);
			expect(refusedEarly.err).toContain("does not exist");
			expect(
				node.calls.slice(before).some((call) => call.route.endsWith("/update"))
			).toBe(false);

			// A write that fails after Core rotated (the path was taken while
			// it did) never loses the shares.
			const racing = (taken: string) =>
				fakeNode({
					"POST /api/vault/sys/rekey/update": async () => {
						await writeFile(taken, "someone else");
						return Response.json({
							complete: true,
							status: IDLE,
							shares: NEW_SHARES,
						});
					},
				});
			const lost = join(dir, "raced.txt");
			const fallback = await runSecrets(
				["rekey", "update", "--out", lost, "--nonce", "n-1"],
				racing(lost),
				stdin
			);
			expect(fallback.code).toBe(1);
			expect(fallback.out.trim().split("\n")).toEqual(NEW_SHARES);
			expect(fallback.err).toContain("EEXIST");
			const lostJson = join(dir, "raced-json.txt");
			const fallbackJson = await runSecrets(
				["rekey", "update", "--out", lostJson, "--nonce", "n-1", "--json"],
				racing(lostJson),
				stdin
			);
			expect(fallbackJson.code).toBe(1);
			const parsed = JSON.parse(fallbackJson.out);
			expect(parsed.shares).toEqual(NEW_SHARES);
			expect(parsed.written).toBe(false);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
