import { describe, expect, test } from "bun:test";
import type { InterfaceActivity } from "@ryuhq/protocol/interfaces";
import {
	authBlocker,
	createStepThrottle,
	failoverBlocker,
	latestAuthLapse,
	liveActivity,
	PERMISSION_WAIT_MS,
	permissionAsk,
	streamErrorBlocker,
} from "./interface-live-tab.ts";

const NOW = 1_760_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("failoverBlocker (test 10c)", () => {
	const resetsAt = "2026-10-16T15:10:00Z";
	test("wait for this thread's agent clears at its reset", () => {
		expect(
			failoverBlocker(
				{ agentId: "ACP:Codex", kind: "wait", note: "Waiting", resetsAt },
				"acp:codex"
			)
		).toEqual({
			at: null,
			clearsAt: resetsAt,
			detail: "Waiting",
			kind: "rate-limited",
			source: "live-tab",
			title: "Limit hit",
		});
	});
	test("wait naming another agent never shows that agent's reset", () => {
		const blocker = failoverBlocker(
			{
				agentId: "acp:other",
				kind: "wait",
				note: "Every plan is out",
				resetsAt,
			},
			"acp:codex"
		);
		expect(blocker?.kind).toBe("rate-limited");
		expect(blocker?.clearsAt).toBeUndefined();
		expect(blocker?.detail).toBe("Every plan is out");
	});
	test("an unknown thread agent never gets a reset time", () => {
		expect(
			failoverBlocker(
				{ agentId: "acp:codex", kind: "wait", note: "n", resetsAt },
				null
			)?.clearsAt
		).toBeUndefined();
	});

	test("held and no_candidate fail the turn with no reset; reroute is no blocker", () => {
		for (const kind of ["held", "no_candidate"] as const) {
			const blocker = failoverBlocker({ kind, note: "n" }, "a");
			expect(blocker).toMatchObject({ detail: "n", kind: "rate-limited" });
			expect(blocker?.clearsAt).toBeUndefined();
		}
		expect(failoverBlocker({ kind: "reroute", note: "moved" }, "a")).toBeNull();
		expect(failoverBlocker(null, "a")).toBeNull();
	});
});

describe("permissionAsk", () => {
	test("maps the prompt with an approximate start, an upper-bound deadline and destructive allows", () => {
		const ask = permissionAsk(
			{
				options: [
					{ kind: "allow_once", name: "Allow once", optionId: "allow_once" },
					{
						kind: "allow_always",
						name: "Always allow",
						optionId: "allow_always",
					},
					{ kind: "reject_once", name: "Reject", optionId: "reject_once" },
				],
				requestId: "req-1",
				toolCall: {
					kind: "edit",
					locations: [{ path: "/repo/deploy.sh" }],
					title: "Edit deploy.sh",
				},
			},
			NOW - 7 * 60_000,
			{ agentId: "ada", threadId: "t-ada" }
		);
		expect(ask).toEqual({
			agentId: "ada",
			blocking: true,
			choices: [
				{
					destructive: true,
					id: "allow_once",
					label: "Allow once",
					tone: "allow",
				},
				{
					destructive: true,
					id: "allow_always",
					label: "Always allow",
					tone: "allow",
				},
				{
					destructive: false,
					id: "reject_once",
					label: "Deny",
					tone: "deny",
				},
			],
			expiresApprox: true,
			expiresAt: iso(NOW - 7 * 60_000 + PERMISSION_WAIT_MS),
			holdsRun: true,
			id: "permission:req-1",
			kind: "permission",
			reason: null,
			since: iso(NOW - 7 * 60_000),
			sinceApprox: true,
			source: "live-tab",
			subject: "edit",
			target: "deploy.sh",
			text: "Allow Edit deploy.sh?",
			threadId: "t-ada",
		});
	});
});

describe("liveActivity and blockers", () => {
	test("the open tool of the newest turn is the live step", () => {
		const activity = liveActivity(
			[
				{ parts: [{ text: "go", type: "text" }], role: "user" },
				{
					parts: [
						{
							input: { command: "ls" },
							output: "",
							state: "output-available",
							type: "tool-Bash",
						},
						{
							callProviderMetadata: { ryu: { startedAt: NOW - 1000 } },
							input: { command: "bun test src" },
							state: "input-available",
							type: "tool-Bash",
						},
					],
					role: "assistant",
				},
			],
			NOW
		);
		expect(activity).toMatchObject({
			kind: "run",
			label: "Running bun test",
			recent: ["run"],
			since: iso(NOW - 1000),
			source: "live-tab",
		});
		expect(liveActivity([{ role: "user" }], NOW)).toBeNull();
	});

	test("stream errors and login lapses", () => {
		expect(streamErrorBlocker({ message: "Network down" }, NOW)).toMatchObject({
			at: iso(NOW),
			detail: "Network down",
			kind: "error",
			source: "live-tab",
		});
		expect(streamErrorBlocker(null, NOW)).toBeNull();
		expect(authBlocker({ message: "Sign in again" }, NOW)).toMatchObject({
			kind: "auth",
			title: "Agent login expired",
		});
	});
});

describe("createStepThrottle (4 Hz, only on change)", () => {
	test("publishes changes at most every 250 ms and never repeats a step", () => {
		let now = 0;
		const timers: { at: number; fn: () => void }[] = [];
		const published: (string | null)[] = [];
		const step = (label: string): InterfaceActivity => ({
			kind: "run",
			label,
			observedAt: iso(NOW),
			source: "live-tab",
		});
		const throttle = createStepThrottle(
			(activity) => published.push(activity?.label ?? null),
			250,
			() => now,
			(fn, ms) => {
				timers.push({ at: now + ms, fn });
				return timers.length;
			},
			() => undefined
		);
		const run = (until: number) => {
			now = until;
			for (const timer of timers.splice(0).filter((t) => t.at <= until)) {
				timer.fn();
			}
		};
		throttle.push(step("a"));
		throttle.push(step("a"));
		throttle.push(step("b"));
		throttle.push(step("c"));
		expect(published).toEqual(["a"]);
		run(250);
		expect(published).toEqual(["a", "c"]);
		throttle.push(step("c"));
		run(600);
		expect(published).toEqual(["a", "c"]);
		throttle.push(null);
		expect(published).toEqual(["a", "c", null]);
	});
});

describe("review follow-ups (B2)", () => {
	test("permission labels come from the option kind and never hide the scope", () => {
		const ask = permissionAsk(
			{
				options: [
					{ kind: "allow_once", name: "Allow for this session", optionId: "a" },
					{
						kind: "allow_always",
						name: "Allow for every session",
						optionId: "b",
					},
					{ kind: "reject_always", name: "Never", optionId: "c" },
					{
						kind: "custom",
						name: "Allow for this project only",
						optionId: "d",
					},
				],
				requestId: "r",
				toolCall: {},
			},
			NOW,
			{ agentId: null, threadId: "t" }
		);
		expect(ask.choices?.map((choice) => choice.label)).toEqual([
			"Allow once",
			"Always allow",
			"Always deny",
			"Allow for…",
		]);
		expect(ask.text).toBe("Allow this tool to run?");
		const twins = permissionAsk(
			{
				options: [
					{ kind: "odd", name: "Go", optionId: "a" },
					{ kind: "odder", name: "go", optionId: "b" },
				],
				requestId: "r",
				toolCall: { title: "Edit x" },
			},
			NOW,
			{ agentId: null, threadId: "t" }
		);
		expect(twins.choices).toBeUndefined();
	});

	test("unknown kinds cut long names to two words and name blank ones by tone", () => {
		const ask = permissionAsk(
			{
				options: [
					{
						kind: "allow_for_project",
						name: "  Allow   for this whole project ",
						optionId: "a",
					},
					{ kind: "reject_for_project", name: "   ", optionId: "b" },
					{ kind: "custom", name: "", optionId: "c" },
				],
				requestId: "r",
				toolCall: {},
			},
			NOW,
			{ agentId: null, threadId: "t" }
		);
		expect(ask.choices?.map((choice) => choice.label)).toEqual([
			"Allow for…",
			"Deny",
			"Choose",
		]);
		for (const choice of ask.choices ?? []) {
			expect(choice.label.split(" ").length).toBeLessThanOrEqual(2);
		}
	});

	test("a login lapse is keyed by message id, not position", () => {
		const lapse = {
			data: { agentId: "a", message: "m" },
			type: "data-ryu-acp-auth-required",
		};
		const before = latestAuthLapse([
			{ id: "m1", parts: [lapse], role: "assistant" },
		]);
		const after = latestAuthLapse([
			{ id: "old", parts: [], role: "assistant" },
			{ id: "m1", parts: [lapse], role: "assistant" },
		]);
		expect(after?.key).toBe(before?.key);
	});

	test("the live step skips step markers and data parts", () => {
		const activity = liveActivity(
			[
				{
					parts: [
						{
							input: { command: "bun test" },
							state: "input-available",
							type: "tool-Bash",
						},
						{ type: "step-start" },
						{ data: { requestId: "r" }, type: "data-ryu-permission" },
					],
					role: "assistant",
				},
			],
			NOW
		);
		expect(activity).toMatchObject({ kind: "run", label: "Running bun test" });
	});

	test("a login lapse counts only in the newest turn", () => {
		const lapse = {
			data: { agentId: "a", message: "m" },
			type: "data-ryu-acp-auth-required",
		};
		expect(
			latestAuthLapse([{ parts: [lapse], role: "assistant" }])?.message
		).toBe("m");
		expect(
			latestAuthLapse([
				{ parts: [lapse], role: "assistant" },
				{ role: "user" },
				{ parts: [{ text: "ok", type: "text" }], role: "assistant" },
			])
		).toBeNull();
	});
});
