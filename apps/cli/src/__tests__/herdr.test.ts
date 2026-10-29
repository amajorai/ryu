import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createHerdrReporter,
	HerdrMetadataRejected,
	HerdrReporter,
	herdrErrorMessage,
	parseResumeOptions,
	resumeArguments,
} from "../core/herdr.ts";
import { buildInteractiveTarget, buildTarget } from "../core/target.ts";

const node = "https://core.example.test";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("resume resolves credentials for the selected saved node without putting them in argv", () => {
	const config = {
		default: "first",
		nodes: [
			{
				name: "first",
				url: "https://first.example.test",
				token: "first-secret",
			},
			{ name: "second", url: node, token: "second-secret" },
			{ name: "public", url: "https://public.example.test", token: null },
		],
	};
	expect(buildInteractiveTarget(node, config)).toEqual({
		url: node,
		token: "second-secret",
	});
	// A tokenless remote saved node gets no bearer, even with RYU_CORE_TOKEN set.
	const savedCoreToken = process.env.RYU_CORE_TOKEN;
	try {
		process.env.RYU_CORE_TOKEN = "local-core-secret";
		expect(
			buildInteractiveTarget("https://public.example.test", config).token
		).toBeNull();
	} finally {
		if (savedCoreToken === undefined) {
			delete process.env.RYU_CORE_TOKEN;
		} else {
			process.env.RYU_CORE_TOKEN = savedCoreToken;
		}
	}
	// No --node: the saved active node ("first"), unless RYU_CORE_URL is set.
	const savedCoreUrl = process.env.RYU_CORE_URL;
	try {
		delete process.env.RYU_CORE_URL;
		expect(buildInteractiveTarget(null, config)).toEqual({
			url: "https://first.example.test",
			token: "first-secret",
		});
		process.env.RYU_CORE_URL = "http://env-node.example.test";
		expect(buildInteractiveTarget(null, config)).toEqual(buildTarget());
	} finally {
		if (savedCoreUrl === undefined) {
			delete process.env.RYU_CORE_URL;
		} else {
			process.env.RYU_CORE_URL = savedCoreUrl;
		}
	}
	// --node <name> resolves the saved node and its credentials.
	expect(buildInteractiveTarget("second", config)).toEqual({
		url: node,
		token: "second-secret",
	});
	// A loopback default target carries its own credential-gating transport, so
	// compare the addressing and credentials, not the transport instance.
	const { fetch: _defaultFetch, ...defaultTarget } = buildTarget();
	expect(buildInteractiveTarget("https://other.example.test", config)).toEqual({
		...defaultTarget,
		url: "https://other.example.test",
	});
	expect(() => buildInteractiveTarget("staging", config)).toThrow(
		"No saved node named or at 'staging'"
	);
	expect(
		JSON.stringify(resumeArguments({ conversationId: "chat" }, node))
	).not.toContain("secret");
});

test("outside a complete Herdr environment the integration is disabled", () => {
	const env = {
		HERDR_ENV: "1",
		HERDR_BIN_PATH: "herdr",
		HERDR_PANE_ID: "pane",
		HERDR_SOCKET_PATH: "socket",
	};
	expect(createHerdrReporter({})).toBeNull();
	for (const key of Object.keys(env)) {
		expect(createHerdrReporter({ ...env, [key]: "" })).toBeNull();
	}
});

test("resume argv round-trips routing options and rejects Herdr-invalid commands", () => {
	const options = {
		conversationId: "chat-1",
		agentId: "agent",
		acpModel: "model",
		acpMode: "ask",
		acpConfig: { effort: "high" },
		pluginFlags: { "io.ryu.double-check": true },
	};
	const argv = resumeArguments(options, node);
	expect(argv?.slice(0, 6)).toEqual([
		"ryu-cli",
		"tui",
		"--node",
		node,
		"--resume",
		"chat-1",
	]);
	expect(parseResumeOptions(argv?.at(-1))).toEqual({
		agentId: "agent",
		acpModel: "model",
		acpMode: "ask",
		acpConfig: { effort: "high" },
		pluginFlags: { "io.ryu.double-check": true },
	});
	expect(
		resumeArguments({ conversationId: "chat", acpModel: "can't" }, node)
	).toBeNull();
	expect(resumeArguments({ conversationId: "chat\n" }, node)).toBeNull();
	expect(resumeArguments({ conversationId: "chat\u0085" }, node)).toBeNull();
	expect(
		resumeArguments(
			{ conversationId: "chat" },
			"https://user:secret@core.example.test"
		)
	).toBeNull();
	expect(
		resumeArguments({ conversationId: "chat" }, `${node}?token=secret`)
	).toBeNull();
	expect(
		resumeArguments(
			{ conversationId: "chat", acpModel: "x".repeat(8192) },
			node
		)
	).toBeNull();
	expect(resumeArguments({}, node)).toBeNull();
	expect(
		parseResumeOptions(
			'{"agentId":2,"acpConfig":{"a":"high","b":false},"pluginFlags":{"a":true,"b":"false"},"token":"secret"}'
		)
	).toEqual({ acpConfig: { a: "high" }, pluginFlags: { a: true } });
	expect(parseResumeOptions("broken")).toEqual({});
});

test("blocked and working background chats take priority and preserve their own node", async () => {
	const reports: string[][] = [];
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
	});
	const idle = Symbol("idle chat");
	const working = Symbol("working chat");
	const blocked = Symbol("blocked chat");
	reporter.update(idle, { focused: true, state: "idle" }, node);
	await tick();
	reporter.update(
		working,
		{
			focused: false,
			state: "working",
			options: { conversationId: "running" },
		},
		"https://other.example.test"
	);
	await tick();
	expect(reports.at(-1)).toContain("working");
	expect(reports.at(-1)).toContain("https://other.example.test");
	reporter.update(
		blocked,
		{
			focused: false,
			state: "blocked",
			message: "Waiting for tool permission",
		},
		node
	);
	await tick();
	expect(reports.at(-1)).toContain("blocked");
	expect(reports.at(-1)).toContain("Waiting for tool permission");
	reporter.remove(blocked);
	await tick();
	expect(reports.at(-1)).toContain("working");
	reporter.remove(working);
	await tick();
	expect(reports.at(-1)).toContain("idle");
	const sequences = reports.map((argv) =>
		Number(argv[argv.indexOf("--seq") + 1])
	);
	expect(
		sequences.every(
			(value, index) => index === 0 || value > sequences[index - 1]
		)
	).toBe(true);
	await reporter.release();
});

test("coalesces queued reports, deduplicates unchanged state, and releases last", async () => {
	const reports: string[][] = [];
	let unblock: (() => void) | undefined;
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
		if (reports.length === 1) {
			await new Promise<void>((resolve) => {
				unblock = resolve;
			});
		}
	});
	const id = Symbol("chat");
	reporter.update(id, { focused: true, state: "working" }, node);
	await tick();
	reporter.update(id, { focused: true, state: "blocked" }, node);
	reporter.update(id, { focused: true, state: "idle" }, node);
	unblock?.();
	await tick();
	expect(reports).toHaveLength(2);
	expect(reports[1]).toContain("idle");
	reporter.update(id, { focused: true, state: "idle" }, node);
	await tick();
	expect(reports).toHaveLength(2);
	await reporter.release();
	await reporter.release();
	reporter.update(id, { focused: true, state: "working" }, node);
	expect(reports).toHaveLength(3);
	expect(reports[2][1]).toBe("release-agent");
});

test("report failures never reject shutdown", async () => {
	const reporter = new HerdrReporter("pane", async () => {
		throw new Error("Herdr unavailable");
	});
	reporter.update(Symbol("chat"), { focused: true, state: "working" }, node);
	await expect(reporter.release()).resolves.toBeUndefined();
});

test("closing a chat surface keeps its independent turn working until completion", async () => {
	const reports: string[][] = [];
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
	});
	const surface = Symbol("surface");
	const turn = Symbol("turn");
	reporter.update(surface, { focused: true, state: "idle" }, node);
	reporter.update(
		turn,
		{
			focused: false,
			state: "working",
			options: { conversationId: "background-chat" },
		},
		node
	);
	await tick();
	reporter.remove(surface);
	await tick();
	expect(reports.at(-1)).toContain("working");
	expect(reports.at(-1)).toContain("background-chat");
	reporter.remove(turn);
	await tick();
	expect(reports.at(-1)).toContain("idle");
	await reporter.release();
});

test("an errored turn reports blocked with its message, then idle once cleared", async () => {
	const reports: string[][] = [];
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
	});
	const chat = Symbol("chat");
	reporter.update(
		chat,
		{ focused: true, state: "blocked", message: "Error: HTTP 500" },
		node
	);
	await tick();
	const blocked = reports.at(-1) ?? [];
	expect(
		blocked.slice(blocked.indexOf("--state"), blocked.indexOf("--seq"))
	).toEqual(["--state", "blocked", "--message", "Error: HTTP 500"]);
	reporter.update(chat, { focused: true, state: "idle" }, node);
	await tick();
	const idle = reports.at(-1) ?? [];
	expect(idle[idle.indexOf("--state") + 1]).toBe("idle");
	expect(idle).not.toContain("--message");
	await reporter.release();
});

test("error attention messages are one capped line without control characters", () => {
	expect(herdrErrorMessage("HTTP 500")).toBe("Error: HTTP 500");
	expect(
		herdrErrorMessage("\n  upstream\u001b]2;pwned\u0007 failed\nstack trace")
	).toBe("Error: upstream]2;pwned failed");
	expect(herdrErrorMessage("")).toBe("Error");
	const long = herdrErrorMessage("x".repeat(500));
	expect([...long]).toHaveLength(80);
	expect(long.endsWith("…")).toBe(true);
});

test("metadata reports title and model on their own latest-wins queue", async () => {
	const reports: string[][] = [];
	let unblock: (() => void) | undefined;
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
		if (argv[1] === "report-metadata" && !unblock) {
			await new Promise<void>((resolve) => {
				unblock = resolve;
			});
		}
	});
	reporter.reportMetadata({ title: "Plan the launch", model: "gpt-5" });
	await tick();
	expect(reports[0]?.slice(0, reports[0].indexOf("--seq"))).toEqual([
		"pane",
		"report-metadata",
		"pane",
		"--source",
		"ryu",
		"--title",
		"Plan the launch",
		"--token",
		"model=gpt-5",
	]);
	// While metadata is in flight, newer titles coalesce to the latest and a
	// state report is never swallowed by them.
	reporter.reportMetadata({ title: "Older title", model: "gpt-5" });
	reporter.reportMetadata({ title: "Newest title", model: null });
	reporter.update(Symbol("chat"), { focused: true, state: "working" }, node);
	await tick();
	expect(reports.some((argv) => argv[1] === "report-agent")).toBe(true);
	unblock?.();
	await tick();
	await tick();
	const metadata = reports.filter((argv) => argv[1] === "report-metadata");
	expect(metadata).toHaveLength(2);
	expect(metadata[1]).toContain("Newest title");
	expect(metadata[1]).toContain("--clear-token");
	reporter.reportMetadata({ title: "Newest title", model: null });
	await tick();
	expect(reports.filter((argv) => argv[1] === "report-metadata")).toHaveLength(
		2
	);
	await reporter.release();
});

test("a Herdr without report-metadata is asked once and never again", async () => {
	const reports: string[][] = [];
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
		if (argv[1] === "report-metadata") {
			throw new HerdrMetadataRejected("unknown command");
		}
	});
	reporter.reportMetadata({ title: "First" });
	await tick();
	await tick();
	reporter.reportMetadata({ title: "Second" });
	await tick();
	expect(reports.filter((argv) => argv[1] === "report-metadata")).toHaveLength(
		1
	);
	reporter.update(Symbol("chat"), { focused: true, state: "idle" }, node);
	await expect(reporter.release()).resolves.toBeUndefined();
	expect(reports.at(-1)?.[1]).toBe("release-agent");
});

test("releasing clears the pane title and model Ryu reported", async () => {
	const reports: string[][] = [];
	const reporter = new HerdrReporter("pane", async (argv) => {
		reports.push(argv);
	});
	reporter.reportMetadata({ title: "Plan the launch", model: "gpt-5" });
	await tick();
	await reporter.release();
	const metadata = reports.filter((argv) => argv[1] === "report-metadata");
	expect(metadata).toHaveLength(2);
	const cleared = metadata[1] ?? [];
	expect(cleared.slice(0, cleared.indexOf("--seq"))).toEqual([
		"pane",
		"report-metadata",
		"pane",
		"--source",
		"ryu",
		"--clear-title",
		"--clear-token",
		"model",
	]);
	// Nothing was reported to clear, or the reporter already stopped.
	const quiet: string[][] = [];
	const unused = new HerdrReporter("pane", async (argv) => {
		quiet.push(argv);
	});
	await unused.release();
	await unused.release();
	expect(quiet.some((argv) => argv[1] === "report-metadata")).toBe(false);
});

test("only a Herdr usage error disables metadata; transient failures retry", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ryu-herdr-"));
	const log = join(directory, "argv.log");
	const binary = join(directory, "herdr");
	writeFileSync(
		binary,
		`#!/bin/sh\necho "$2" >> "${log}"\n[ "$2" = report-metadata ] && exit "$FAKE_HERDR_EXIT"\nexit 0\n`
	);
	chmodSync(binary, 0o755);
	const reporterFor = (exitCode: number) =>
		createHerdrReporter({
			FAKE_HERDR_EXIT: String(exitCode),
			HERDR_BIN_PATH: binary,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "pane",
			HERDR_SOCKET_PATH: "socket",
		});
	const metadataCalls = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line === "report-metadata").length;
	const waitForCalls = async (count: number) => {
		for (let index = 0; index < 200 && metadataCalls() < count; index++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	try {
		writeFileSync(log, "");
		const flaky = reporterFor(1);
		flaky?.reportMetadata({ title: "First" });
		await waitForCalls(1);
		flaky?.reportMetadata({ title: "Second" });
		await waitForCalls(2);
		await flaky?.release();
		// Both titles were tried, then the release cleared them.
		expect(metadataCalls()).toBe(3);

		writeFileSync(log, "");
		const old = reporterFor(2);
		old?.reportMetadata({ title: "First" });
		await waitForCalls(1);
		// Let the rejected exit code land before asking again.
		await new Promise((resolve) => setTimeout(resolve, 100));
		old?.reportMetadata({ title: "Second" });
		await old?.release();
		expect(metadataCalls()).toBe(1);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
