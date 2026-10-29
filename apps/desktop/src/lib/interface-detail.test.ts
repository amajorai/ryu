import { describe, expect, test } from "bun:test";
import {
	type DeriveDetailExtras,
	type DetailMessage,
	deriveThreadDetail,
	errorCodeKind,
	QUESTION_WAIT_MS,
	resolveLastProgress,
	toolActivityLabel,
} from "./interface-detail.ts";

const MINUTE = 60_000;
/** Realistic epoch ms. */
const NOW = 1_760_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const timing = (startedAt: number, completedAt?: number) => ({
	callProviderMetadata: {
		ryu: completedAt === undefined ? { startedAt } : { completedAt, startedAt },
	},
});

function user(id: string, timestamp: number, text = "Do it"): DetailMessage {
	return {
		content: text,
		id,
		parts: [{ text, type: "text" }],
		role: "user",
		timestamp,
	};
}

function assistant(
	id: string,
	timestamp: number,
	parts: unknown[],
	extra: Partial<DetailMessage> = {}
): DetailMessage {
	return { content: "", id, parts, role: "assistant", timestamp, ...extra };
}

function extras(
	overrides: Partial<DeriveDetailExtras> = {}
): DeriveDetailExtras {
	return {
		agentId: "coder",
		hasOlder: false,
		nowMs: NOW,
		running: true,
		threadId: "t",
		...overrides,
	};
}

const editPart = {
	input: {
		file_path: "/repo/src/snapshot.ts",
		new_string: "b",
		old_string: "a",
	},
	state: "input-available",
	toolCallId: "e1",
	type: "tool-Edit",
	...timing(NOW - MINUTE),
};

const todoPart = {
	input: {
		todos: [
			{ content: "read code", status: "completed" },
			{ content: "map fields", status: "completed" },
			{ content: "write snapshot", status: "completed" },
			{ content: "update snapshot builder", status: "in_progress" },
			{ content: "write tests", status: "pending" },
			{ content: "run lint", status: "pending" },
			{ content: "push", status: "pending" },
		],
	},
	output: "ok",
	state: "output-available",
	toolCallId: "todo",
	type: "tool-TodoWrite",
	...timing(NOW - 3 * MINUTE, NOW - 3 * MINUTE + 10),
};

function question(overrides: Record<string, unknown> = {}) {
	return {
		input: {
			question: {
				description: "Pick the database.",
				kind: "single",
				options: [
					{ id: "postgres", label: "Postgres" },
					{ id: "sqlite", label: "SQLite" },
				],
				title: "Which DB to use?",
			},
		},
		state: "input-available",
		toolCallId: "q1",
		type: "tool-Question",
		...timing(NOW - 3 * MINUTE),
		...overrides,
	};
}

describe("deriveThreadDetail (test 10)", () => {
	test("an open Edit part is the current step", () => {
		const detail = deriveThreadDetail(
			[
				user("u", NOW - 10 * MINUTE),
				assistant("a", NOW - 9 * MINUTE, [
					{
						input: { file_path: "/repo/a.ts" },
						output: "x",
						state: "output-available",
						toolCallId: "r1",
						type: "tool-Read",
					},
					editPart,
				]),
			],
			extras()
		);
		expect(detail.activity).toMatchObject({
			kind: "edit",
			label: "Editing snapshot.ts",
			recent: ["read"],
			since: iso(NOW - MINUTE),
			target: "snapshot.ts",
			tool: "Edit",
		});
		expect(detail.progressMarks.turnPartAt).toBe(NOW - MINUTE);
		expect(resolveLastProgress(detail.progressMarks, null)).toBe(NOW - MINUTE);
	});

	test("TodoWrite gives plan progress with the honest next item", () => {
		const detail = deriveThreadDetail(
			[
				user("u", NOW - 10 * MINUTE),
				assistant("a", NOW - 9 * MINUTE, [todoPart]),
			],
			extras()
		);
		expect(detail.progress).toEqual({
			current: "update snapshot builder",
			done: 3,
			kind: "plan",
			next: "write tests",
			source: "messages",
			total: 7,
		});
	});

	test("blocker precedence: error card, then failed command, then interrupted", () => {
		const failedBash = {
			errorText: "2 tests failed",
			input: { command: "bun test src" },
			state: "output-error",
			toolCallId: "b1",
			type: "tool-Bash",
			...timing(NOW - 21 * MINUTE, NOW - 20 * MINUTE),
		};
		const errorCard = {
			code: "auth_required",
			message: "Sign in again.",
			title: "Agent login expired",
			type: "error",
		};
		const stopped = extras({ running: false });
		const all = deriveThreadDetail(
			[
				user("u", NOW - 30 * MINUTE),
				assistant("a", NOW - 25 * MINUTE, [failedBash, errorCard], {
					interrupted: true,
				}),
			],
			stopped
		);
		expect(all.blocker).toMatchObject({
			at: iso(NOW - 25 * MINUTE),
			atApprox: true,
			detail: "Sign in again.",
			kind: "auth",
			title: "Agent login expired",
		});
		const command = deriveThreadDetail(
			[
				user("u", NOW - 30 * MINUTE),
				assistant("a", NOW - 25 * MINUTE, [failedBash], { interrupted: true }),
			],
			stopped
		);
		expect(command.blocker).toEqual({
			at: iso(NOW - 20 * MINUTE),
			atApprox: false,
			detail: "2 tests failed",
			kind: "command-failed",
			source: "messages",
			title: "bun test failed",
		});
		const untimed = deriveThreadDetail(
			[
				user("u", NOW - 30 * MINUTE),
				assistant("a", NOW - 25 * MINUTE, [
					{ ...failedBash, callProviderMetadata: undefined },
				]),
			],
			stopped
		);
		expect(untimed.blocker).toMatchObject({
			at: iso(NOW - 25 * MINUTE),
			atApprox: true,
		});
		const cut = deriveThreadDetail(
			[
				user("u", NOW - 30 * MINUTE),
				assistant("a", NOW - 25 * MINUTE, [{ text: "half", type: "text" }], {
					interrupted: true,
				}),
			],
			stopped
		);
		expect(cut.blocker).toMatchObject({
			kind: "interrupted",
			title: "Interrupted",
		});
	});

	test("saved error codes map to blocker kinds; none maps to rate-limited", () => {
		expect(errorCodeKind("auth_required")).toBe("auth");
		expect(errorCodeKind("native_account_required")).toBe("auth");
		expect(errorCodeKind("provider_payment_required")).toBe("billing");
		expect(errorCodeKind("insufficient_credits")).toBe("billing");
		expect(errorCodeKind("execution_paused")).toBe("interrupted");
		expect(errorCodeKind("agent_error")).toBe("error");
		expect(errorCodeKind(null)).toBe("error");
		const billing = deriveThreadDetail(
			[
				user("u", NOW - 3 * MINUTE),
				assistant("a", NOW - 2 * MINUTE, [
					{ code: "provider_payment_required", message: "Pay", type: "error" },
				]),
			],
			extras({ running: false })
		);
		expect(billing.blocker?.kind).toBe("billing");
		expect(billing.blocker?.clearsAt).toBeUndefined();
	});

	test("an open blocking question while running: exact since, upper-bound deadline, choices", () => {
		const detail = deriveThreadDetail(
			[
				user("u", NOW - 5 * MINUTE),
				assistant("a", NOW - 4 * MINUTE, [question()]),
			],
			extras()
		);
		expect(detail.questionAsks).toHaveLength(1);
		expect(detail.questionAsks[0]?.ask).toMatchObject({
			blocking: true,
			choices: [
				{ id: "postgres", label: "Postgres", tone: "neutral" },
				{ id: "sqlite", label: "SQLite", tone: "neutral" },
			],
			expiresApprox: true,
			expiresAt: iso(NOW - 3 * MINUTE + QUESTION_WAIT_MS),
			holdsRun: true,
			id: "question:q1",
			reason: "Pick the database.",
			since: iso(NOW - 3 * MINUTE),
			text: "Which DB to use?",
			threadId: "t",
		});
		expect(detail.questionAsks[0]?.holderId).toBe("t");
	});

	test("a blocking question on a stopped thread, or past its deadline, yields no ask", () => {
		const messages = [
			user("u", NOW - 5 * MINUTE),
			assistant("a", NOW - 4 * MINUTE, [question()]),
		];
		expect(
			deriveThreadDetail(messages, extras({ running: false })).questionAsks
		).toEqual([]);
		expect(
			deriveThreadDetail(messages, extras({ nowMs: NOW + QUESTION_WAIT_MS }))
				.questionAsks
		).toEqual([]);
	});

	test("a deferred question is a non-blocking suggestion, running or not", () => {
		const deferred = question({
			output: { output: { deferred: true }, status: "ok" },
			state: "output-available",
		});
		for (const running of [true, false]) {
			const [entry] = deriveThreadDetail(
				[
					user("u", NOW - 5 * MINUTE),
					assistant("a", NOW - 4 * MINUTE, [deferred]),
				],
				extras({ running })
			).questionAsks;
			expect(entry?.ask).toMatchObject({ blocking: false, holdsRun: false });
			expect(entry?.ask.expiresAt).toBeUndefined();
			expect(entry?.ask.choices).toBeUndefined();
		}
	});

	test("only a single single-select question without custom answers gets choices", () => {
		const multi = question({
			input: {
				question: {
					kind: "multi",
					options: [{ id: "a", label: "A" }],
					title: "Pick some",
				},
			},
		});
		const custom = question({
			input: {
				question: {
					allowCustom: true,
					kind: "single",
					options: [{ id: "a", label: "A" }],
					title: "Pick",
				},
			},
		});
		for (const part of [multi, custom]) {
			const [entry] = deriveThreadDetail(
				[user("u", NOW - 5 * MINUTE), assistant("a", NOW - 4 * MINUTE, [part])],
				extras()
			).questionAsks;
			expect(entry?.ask.blocking).toBe(true);
			expect(entry?.ask.choices).toBeUndefined();
		}
	});

	test("labels that collide once cut to two words drop the choices (Open only)", () => {
		const twins = question({
			input: {
				question: {
					kind: "single",
					options: [
						{ id: "a", label: "Use the old schema" },
						{ id: "b", label: "Use the new schema" },
					],
					title: "Which schema?",
				},
			},
		});
		const [entry] = deriveThreadDetail(
			[user("u", NOW - 5 * MINUTE), assistant("a", NOW - 4 * MINUTE, [twins])],
			extras()
		).questionAsks;
		expect(entry?.ask.choices).toBeUndefined();
	});

	test("a step without a target reads by the transcript registry's title", () => {
		const detail = deriveThreadDetail(
			[
				user("u", NOW - 5 * MINUTE),
				assistant("a", NOW - 4 * MINUTE, [
					{
						input: { description: "scan", subagent_type: "Explore" },
						state: "input-available",
						toolCallId: "t1",
						type: "tool-Task",
					},
				]),
			],
			extras()
		);
		expect(detail.activity).toMatchObject({
			kind: "delegate",
			label: "Running Explore",
		});
	});

	test("a helper session's question is lifted to its parent", () => {
		const [entry] = deriveThreadDetail(
			[
				user("u", NOW - 5 * MINUTE),
				assistant("a", NOW - 4 * MINUTE, [question()]),
			],
			extras({
				liftTo: { agentId: "coder", threadId: "main" },
				threadId: "session",
			})
		).questionAsks;
		expect(entry?.ask.threadId).toBe("main");
		expect(entry?.holderId).toBe("session");
	});

	test("outcome describes the newest finished turn only, failures counted once", () => {
		const edit = (id: string, path: string) => ({
			input: { file_path: path, new_string: "b\nc", old_string: "a" },
			output: "ok",
			state: "output-available",
			toolCallId: id,
			type: "tool-Edit",
		});
		const failed = (
			id: string,
			type: string,
			input: Record<string, unknown>
		) => ({
			errorText: "boom",
			input,
			state: "output-error",
			toolCallId: id,
			type,
		});
		const messages = [
			user("u1", NOW - 60 * MINUTE),
			assistant("a1", NOW - 59 * MINUTE, [
				edit("e1", "/r/a.ts"),
				edit("e2", "/r/b.ts"),
				edit("e3", "/r/c.ts"),
			]),
			user("u2", NOW - 30 * MINUTE),
			assistant("a2", NOW - 29 * MINUTE, [
				edit("e4", "/r/d.ts"),
				failed("b1", "tool-Bash", { command: "bun test" }),
				{ text: "Fixed d. Tests still fail.", type: "text" },
			]),
		];
		const detail = deriveThreadDetail(messages, extras({ running: false }));
		expect(detail.outcome).toMatchObject({
			deletions: 1,
			failures: 1,
			filesChanged: 1,
			insertions: 2,
			summary: "Fixed d.",
		});
		expect(detail.activity).toBeNull();
		const two = deriveThreadDetail(
			[
				user("u2", NOW - 30 * MINUTE),
				assistant("a2", NOW - 29 * MINUTE, [
					failed("b1", "tool-Bash", { command: "bun test" }),
					failed("e9", "tool-Edit", { file_path: "/r/x.ts" }),
				]),
			],
			extras({ running: false })
		);
		expect(two.outcome?.failures).toBe(2);
	});

	test("a dangling newest turn, or a running thread, has no outcome", () => {
		const dangling = [
			user("u1", NOW - 60 * MINUTE),
			assistant("a1", NOW - 59 * MINUTE, [{ text: "Done.", type: "text" }]),
			user("u2", NOW - 30 * MINUTE),
			assistant("a2", NOW - 29 * MINUTE, [editPart]),
		];
		expect(
			deriveThreadDetail(dangling, extras({ running: false })).outcome
		).toBeNull();
		expect(
			deriveThreadDetail(dangling, extras({ running: true })).outcome
		).toBeNull();
	});

	test("counts are absent when the turn starts at the page boundary with older pages", () => {
		const messages = [
			user("u1", NOW - 60 * MINUTE),
			assistant("a1", NOW - 59 * MINUTE, [
				{ text: "Answered here.", type: "text" },
			]),
		];
		const cut = deriveThreadDetail(
			messages,
			extras({ hasOlder: true, running: false })
		);
		expect(cut.outcome?.headline).toBe("Answered");
		expect(cut.outcome?.filesChanged).toBeUndefined();
		expect(cut.outcome?.failures).toBeUndefined();
	});

	test("hydrated parts never carry a failover part or a rate-limited blocker", () => {
		const detail = deriveThreadDetail(
			[
				user("u", NOW - 3 * MINUTE),
				assistant("a", NOW - 2 * MINUTE, [
					{ code: "agent_error", message: "429 from upstream", type: "error" },
				]),
			],
			extras({ running: false })
		);
		expect(detail.blocker?.kind).toBe("error");
	});

	test("userStart and hasLaterAssistant; progress floors at the run start", () => {
		const detail = deriveThreadDetail(
			[user("u", NOW - 10 * MINUTE), assistant("a", NOW - 20 * MINUTE, [])],
			extras()
		);
		expect(detail.userStart).toBe(NOW - 10 * MINUTE);
		expect(detail.hasLaterAssistant).toBe(true);
		expect(resolveLastProgress(detail.progressMarks, NOW - 5 * MINUTE)).toBe(
			NOW - 5 * MINUTE
		);
		const fresh = deriveThreadDetail([user("u", NOW - MINUTE)], extras());
		expect(fresh.hasLaterAssistant).toBe(false);
	});

	test("progress marks skip broken timestamps; with no start only the turn counts", () => {
		const detail = deriveThreadDetail(
			[
				assistant("old", NOW - 3 * 60 * MINUTE, [
					{
						state: "output-available",
						type: "tool-Read",
						...timing(NOW - 3 * 60 * MINUTE),
					},
				]),
				user("u", NOW - 10 * MINUTE),
				assistant("bad", Number.NaN, []),
				assistant("a", NOW - 2 * MINUTE, []),
			],
			extras()
		);
		expect(detail.progressMarks.messageAt).toBe(NOW - 2 * MINUTE);
		expect(detail.progressMarks.turnPartAt).toBeNull();
		expect(resolveLastProgress(detail.progressMarks, null)).toBe(
			NOW - 2 * MINUTE
		);
	});

	test("a tool streaming its input with no target reads as the bare verb", () => {
		expect(
			toolActivityLabel({ input: {}, type: "tool-Edit" }, "edit", "Edit")
		).toBe("Editing");
		expect(
			toolActivityLabel({ input: {}, type: "tool-Write" }, "write", "Write")
		).toBe("Writing");
		// The registry's own verb-led title still wins when it has one.
		expect(
			toolActivityLabel({ input: {}, type: "tool-Bash" }, "run", "Bash")
		).toBe("Running command");
		expect(
			toolActivityLabel({ input: {}, type: "tool-Mystery" }, "tool", "Mystery")
		).toBe("Using Mystery");
	});

	test("choices that differ only by case or the cut mark give Open only", () => {
		const near = question({
			input: {
				question: {
					kind: "single",
					options: [
						{ id: "a", label: "Use the" },
						{ id: "b", label: "use the new one" },
					],
					title: "Which?",
				},
			},
		});
		const [entry] = deriveThreadDetail(
			[user("u", NOW - 5 * MINUTE), assistant("a", NOW - 4 * MINUTE, [near])],
			extras()
		).questionAsks;
		expect(entry?.ask.choices).toBeUndefined();
	});
});
