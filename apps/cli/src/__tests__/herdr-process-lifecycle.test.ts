import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHerdrReporter, type HerdrReporter } from "../core/herdr.ts";

interface Event {
	argv: string[];
	kind: "start" | "exit" | "signal";
	pid: number;
}
// Complete log records published by this fixture's native child process.
const eventFields = z.object({
	argv: z.array(z.string()),
	kind: z.enum(["start", "exit", "signal"]),
	pid: z.union([
		z.number(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
	]),
});
const nativeEventObservation = z.custom<Event>(
	(value) => eventFields.safeParse(value).success
);
interface Fixture {
	directory: string;
	gate: string;
	log: string;
	reporter: HerdrReporter;
}
let fixture: Fixture | undefined;
const node = "https://selected-node.example.test";
const syntheticToken = "fixture-node-token-never-in-argv";
const syntheticJwt = "fixture-user-jwt-never-in-argv";

function events(current: Fixture): Event[] {
	if (!existsSync(current.log)) {
		return [];
	}
	return readFileSync(current.log, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const admitted = nativeEventObservation.safeParse(JSON.parse(line));
			if (!admitted.success) {
				throw new Error("Malformed owned Herdr fixture log");
			}
			const value = admitted.data;
			return { pid: value.pid, argv: value.argv, kind: value.kind };
		});
}
async function waitFor(
	current: Fixture,
	predicate: (rows: Event[]) => boolean,
	timeout = 2000
) {
	const deadline = performance.now() + timeout;
	while (!predicate(events(current)) && performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const rows = events(current);
	if (!predicate(rows)) {
		throw new Error(`Herdr subprocess did not settle: ${JSON.stringify(rows)}`);
	}
	return rows;
}
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") {
			return false;
		}
		throw error;
	}
}
afterEach(async () => {
	const current = fixture;
	fixture = undefined;
	if (!current) {
		return;
	}
	// Release only this fixture's gate and let the real reporter reap its own
	// children. Never use process-name kills or remove state while a child runs.
	writeFileSync(current.gate, "release");
	try {
		await current.reporter.release();
		await waitFor(current, (rows) =>
			rows.filter((row) => row.kind === "start").every((row) => !alive(row.pid))
		);
	} finally {
		if (
			events(current)
				.filter((row) => row.kind === "start")
				.every((row) => !alive(row.pid))
		) {
			rmSync(current.directory, { recursive: true, force: true });
		}
	}
});

function makeFixture(mode: "legacy-hold" | "timeout"): Fixture {
	const directory = mkdtempSync(join(tmpdir(), "ryu-herdr-process-"));
	const log = join(directory, "argv.jsonl");
	const gate = join(directory, "release-gate");
	const script = join(directory, "fixture.mjs");
	const executable = join(directory, "herdr-fixture");
	writeFileSync(
		script,
		`import { appendFileSync, existsSync } from "node:fs";
const argv = process.argv.slice(2);
const log = process.env.RYU_HERDR_FIXTURE_LOG;
const event = (kind) => appendFileSync(log, JSON.stringify({kind, pid:process.pid, argv}) + "\\n");
event("start");
if (argv[0] !== "pane" || !["report-agent", "release-agent"].includes(argv[1])) process.exit(65);
if (argv[1] === "report-agent" && argv.includes("--")) {
  if (process.env.RYU_HERDR_FIXTURE_MODE === "legacy-hold") { event("exit"); process.exit(64); }
  process.on("SIGTERM", () => { event("signal"); process.exit(143); });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (argv[1] === "report-agent" && process.env.RYU_HERDR_FIXTURE_MODE === "legacy-hold") {
  while (!existsSync(process.env.RYU_HERDR_FIXTURE_GATE)) await new Promise(resolve => setTimeout(resolve, 10));
}
event("exit");
`
	);
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		executable,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`
	);
	chmodSync(executable, 0o700);
	const reporter = createHerdrReporter({
		HERDR_ENV: "1",
		HERDR_BIN_PATH: executable,
		HERDR_PANE_ID: "owned-pane",
		HERDR_SOCKET_PATH: join(directory, "unused-owned.socket"),
		RYU_HERDR_FIXTURE_LOG: log,
		RYU_HERDR_FIXTURE_GATE: gate,
		RYU_HERDR_FIXTURE_MODE: mode,
		HOME: directory,
		USERPROFILE: directory,
		RYU_DIR: directory,
		RYU_GATEWAY_TOKEN: syntheticToken,
		RYU_USER_JWT: syntheticJwt,
	});
	if (!reporter) {
		throw new Error(
			"Complete Herdr environment did not enable production reporter"
		);
	}
	fixture = { directory, log, gate, reporter };
	return fixture;
}

test("real Herdr subprocess refuses resume syntax, retries exact legacy argv, and releases once after a held report", async () => {
	const current = makeFixture("legacy-hold");
	const options = {
		conversationId: "owned-conversation",
		agentId: "chosen-agent",
		acpMode: "ask",
		acpConfig: { effort: "high" },
	};
	current.reporter.update(
		Symbol("chat"),
		{
			focused: true,
			state: "blocked",
			message: "Awaiting tool permission",
			options,
		},
		node
	);
	let rows = await waitFor(
		current,
		(entries) => entries.filter((row) => row.kind === "start").length === 2
	);
	const starts = rows.filter((row) => row.kind === "start");
	const original = starts[0]?.argv;
	if (!original) {
		throw new Error("No original invocation");
	}
	const separator = original.indexOf("--");
	expect(original.slice(0, original.indexOf("--seq"))).toEqual([
		"pane",
		"report-agent",
		"owned-pane",
		"--source",
		"ryu",
		"--agent",
		"ryu",
		"--state",
		"blocked",
		"--message",
		"Awaiting tool permission",
		"--agent-session-id",
		"owned-conversation",
	]);
	expect(original.slice(separator + 1)).toEqual([
		"ryu-cli",
		"tui",
		"--node",
		node,
		"--resume",
		"owned-conversation",
		"--resume-options",
		JSON.stringify({
			agentId: "chosen-agent",
			acpMode: "ask",
			acpConfig: { effort: "high" },
		}),
	]);
	expect(starts[1]?.argv).toEqual(original.slice(0, separator));
	let released = false;
	const releaseOne = current.reporter.release().then(() => {
		released = true;
	});
	const releaseTwo = current.reporter.release();
	await Promise.resolve();
	expect(released).toBe(false);
	expect(events(current).filter((row) => row.kind === "start")).toHaveLength(2);
	writeFileSync(current.gate, "release");
	await Promise.all([releaseOne, releaseTwo]);
	current.reporter.update(
		Symbol("after-stop"),
		{ focused: true, state: "working" },
		node
	);
	rows = await waitFor(current, (entries) =>
		entries
			.filter((row) => row.kind === "start")
			.every((row) => !alive(row.pid))
	);
	const completedStarts = rows.filter((row) => row.kind === "start");
	expect(completedStarts).toHaveLength(3);
	const release = completedStarts[2]?.argv;
	if (!release) {
		throw new Error("Release missing");
	}
	expect(release.slice(0, -1)).toEqual([
		"pane",
		"release-agent",
		"owned-pane",
		"--source",
		"ryu",
		"--agent",
		"ryu",
		"--seq",
	]);
	expect(Number(release.at(-1))).toBeGreaterThan(
		Number(original[original.indexOf("--seq") + 1])
	);
	for (const row of rows) {
		expect(JSON.stringify(row.argv)).not.toContain(syntheticToken);
		expect(JSON.stringify(row.argv)).not.toContain(syntheticJwt);
	}
	const heldExit = rows.findIndex(
		(row) => row.kind === "exit" && row.pid === starts[1]?.pid
	);
	const releaseStart = rows.findIndex(
		(row) => row.kind === "start" && row.argv[1] === "release-agent"
	);
	expect(heldExit).toBeGreaterThanOrEqual(0);
	expect(releaseStart).toBeGreaterThan(heldExit);
}, 15_000);

test("production five-second timeout reaps only the hanging owned child, falls back, and completes release", async () => {
	const current = makeFixture("timeout");
	const started = performance.now();
	current.reporter.update(
		Symbol("chat"),
		{
			focused: true,
			state: "working",
			options: { conversationId: "timeout-chat" },
		},
		node
	);
	await waitFor(current, (rows) => rows.some((row) => row.kind === "start"));
	const release = current.reporter.release();
	await release;
	const elapsed = performance.now() - started;
	expect(elapsed).toBeGreaterThanOrEqual(4500);
	expect(elapsed).toBeLessThan(12_000);
	const rows = await waitFor(current, (entries) =>
		entries
			.filter((row) => row.kind === "start")
			.every((row) => !alive(row.pid))
	);
	const starts = rows.filter((row) => row.kind === "start");
	expect(starts).toHaveLength(3);
	expect(starts.map((row) => row.argv[1])).toEqual([
		"report-agent",
		"report-agent",
		"release-agent",
	]);
	const original = starts[0];
	if (!original) {
		throw new Error("Timed-out child not logged");
	}
	expect(
		rows.filter((row) => row.kind === "signal").map((row) => row.pid)
	).toEqual([original.pid]);
	expect(starts[1]?.argv).toEqual(
		original.argv.slice(0, original.argv.indexOf("--"))
	);
	expect(alive(original.pid)).toBe(false);
}, 15_000);
