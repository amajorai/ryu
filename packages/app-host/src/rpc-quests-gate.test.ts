import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatchRpc, type HostServices } from "./rpc.ts";
import {
	gateQuests,
	QUEST_INBOX_VERBS,
	QUEST_VERBS,
	questAccessFor,
	questInboxRecordSchema,
} from "./rpc-quests-gate.ts";

// The grants quests:crud and quests:capture are approvable for any app id, so a
// grant alone must not open the board. These tests drive the gate through the
// bridge dispatcher with in-memory services. Nothing here talks to a node.

const NOW = "2026-01-01T00:00:00Z";
const KEPT_TEXT = "kept text from another app";
const SCRATCHPAD = "private scratchpad text";

// One row as the board stores it, with every field the sidecar sends.
const FULL_ROW = {
	body: KEPT_TEXT,
	completion_condition: "the private condition",
	created_at: NOW,
	detail: "the private detail",
	id: "q1",
	kind: "snippet",
	pinned: false,
	source: {
		app: "Browser",
		title: "a private window title",
		url: "https://example.test/private",
	},
	status: "open",
	suggestion: {
		confidence: 80,
		evidence: "a private evidence snippet",
		reason: "looks done",
		suggested_at: NOW,
	},
	title: "Ship the report",
	updated_at: NOW,
};

const REDUCED_ROW = {
	completion_condition: "",
	created_at: NOW,
	id: "q1",
	status: "open",
	suggestion: { confidence: 80, reason: "looks done", suggested_at: NOW },
	title: "Ship the report",
	updated_at: NOW,
};

const QUEST_METHOD_ROW = /"method": "quests\.(\w+)"/g;

const GRANTED = new Set(["quests.crud", "quests.capture"] as const);

function board() {
	const calls: string[] = [];
	const row = (verb: string) => () => {
		calls.push(verb);
		return Promise.resolve(FULL_ROW);
	};
	const nothing = (verb: string) => () => {
		calls.push(verb);
		return Promise.resolve();
	};
	const services: Partial<HostServices> = {
		questsAcceptSuggestion: row("questsAcceptSuggestion"),
		questsCapture: row("questsCapture"),
		questsComplete: row("questsComplete"),
		questsCreate: row("questsCreate"),
		questsDelete: nothing("questsDelete"),
		questsDismiss: row("questsDismiss"),
		questsDismissSuggestion: row("questsDismissSuggestion"),
		questsJudge: () => {
			calls.push("questsJudge");
			return Promise.resolve({ confidence: 90, met: true, reason: "seen" });
		},
		questsList: () => {
			calls.push("questsList");
			return Promise.resolve([FULL_ROW]);
		},
		questsOpenDetectionSettings: () => {
			calls.push("questsOpenDetectionSettings");
		},
		questsPin: row("questsPin"),
		questsScratchpad: () => {
			calls.push("questsScratchpad");
			return Promise.resolve(SCRATCHPAD);
		},
		questsSetScratchpad: nothing("questsSetScratchpad"),
		questsUpdate: row("questsUpdate"),
		questsUse: row("questsUse"),
	};
	return { calls, services };
}

const QUEST_INPUT = { completion_condition: "done when sent", title: "T" };

// One valid call for each of the fifteen methods.
const CALLS: [method: string, args: unknown[]][] = [
	["quests.acceptSuggestion", [{ id: "q1" }]],
	["quests.capture", [{ body: "planted text" }]],
	["quests.complete", [{ id: "q1" }]],
	["quests.create", [QUEST_INPUT]],
	["quests.delete", [{ id: "q1" }]],
	["quests.dismiss", [{ id: "q1" }]],
	["quests.dismissSuggestion", [{ id: "q1" }]],
	["quests.judge", [{ id: "q1" }]],
	["quests.list", []],
	["quests.openDetectionSettings", []],
	["quests.pin", [{ id: "q1" }]],
	["quests.scratchpad", []],
	["quests.setScratchpad", [{ text: "overwritten" }]],
	["quests.update", [{ id: "q1", input: QUEST_INPUT }]],
	["quests.use", [{ id: "q1" }]],
];

const INBOX_METHODS = new Set([
	"quests.acceptSuggestion",
	"quests.dismissSuggestion",
	"quests.list",
]);

function call(
	pluginId: string,
	services: Partial<HostServices>,
	method: string,
	args: unknown[]
) {
	return dispatchRpc(
		method,
		args,
		GRANTED,
		gateQuests(pluginId, services) as HostServices
	);
}

describe("quests owner gate", () => {
	test("an app that holds both quest grants is refused every quest method and no service runs", async () => {
		const { calls, services } = board();
		for (const [method, args] of CALLS) {
			await expect(
				call("@acme/board", services, method, args)
			).rejects.toMatchObject({ code: "denied" });
		}
		expect(calls).toEqual([]);
	});

	test("an id that only looks like the owner is refused too", async () => {
		const { calls, services } = board();
		for (const pluginId of ["@acme/quests", "@ryu/quests-plus", "quests"]) {
			await expect(
				call(pluginId, services, "quests.list", [])
			).rejects.toMatchObject({ code: "denied" });
			await expect(
				call(pluginId, services, "quests.scratchpad", [])
			).rejects.toMatchObject({ code: "denied" });
		}
		expect(calls).toEqual([]);
	});

	test("the inbox app reads list rows without the kept text, its source, the detail or the evidence", async () => {
		const { calls, services } = board();
		const reply = await call("@ryu/approvals", services, "quests.list", []);
		expect(reply).toEqual([REDUCED_ROW]);
		const wire = JSON.stringify(reply);
		expect(wire).not.toContain(KEPT_TEXT);
		expect(wire).not.toContain("private");
		expect(calls).toEqual(["questsList"]);
	});

	test("the inbox app's accept and dismiss replies are reduced the same way", async () => {
		const { calls, services } = board();
		const input = [{ id: "q1" }];
		expect(
			await call("@ryu/approvals", services, "quests.acceptSuggestion", input)
		).toEqual(REDUCED_ROW);
		expect(
			await call("@ryu/approvals", services, "quests.dismissSuggestion", input)
		).toEqual(REDUCED_ROW);
		expect(calls).toEqual([
			"questsAcceptSuggestion",
			"questsDismissSuggestion",
		]);
	});

	test("the inbox app is refused the scratchpad, capture and every other write", async () => {
		const { calls, services } = board();
		for (const [method, args] of CALLS) {
			if (INBOX_METHODS.has(method)) {
				continue;
			}
			await expect(
				call("@ryu/approvals", services, method, args)
			).rejects.toMatchObject({ code: "denied" });
		}
		expect(calls).toEqual([]);
	});

	test("the Quests app keeps every service and every field", async () => {
		const { calls, services } = board();
		expect(gateQuests("@ryu/quests", services)).toBe(services);
		expect(gateQuests("com.ryu.quests", services)).toBe(services);
		expect(await call("@ryu/quests", services, "quests.list", [])).toEqual([
			FULL_ROW,
		]);
		expect(await call("@ryu/quests", services, "quests.scratchpad", [])).toBe(
			SCRATCHPAD
		);
		expect(calls).toEqual(["questsList", "questsScratchpad"]);
	});

	test("ids are matched whole, after trimming and lower-casing as the workflows guard does", () => {
		expect(questAccessFor("@ryu/quests")).toBe("board");
		expect(questAccessFor(" @Ryu/Quests ")).toBe("board");
		expect(questAccessFor("com.ryu.quests")).toBe("board");
		expect(questAccessFor("@ryu/approvals")).toBe("inbox");
		expect(questAccessFor("com.ryu.approvals")).toBe("inbox");
		expect(questAccessFor("@ryu/quests/x")).toBe("none");
		expect(questAccessFor("@ryu/approvals2")).toBe("none");
		expect(questAccessFor("")).toBe("none");
	});

	test("a row the inbox list cannot validate is refused, not passed on", async () => {
		const { services } = board();
		const broken = {
			...services,
			questsList: () =>
				Promise.resolve([{ body: KEPT_TEXT, id: "q1", title: "T" }]),
		};
		const failure = await call(
			"@ryu/approvals",
			broken,
			"quests.list",
			[]
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(JSON.stringify(failure)).not.toContain(KEPT_TEXT);
	});

	test("the reduced row keeps the keys the shipped inbox schema requires", () => {
		const row = questInboxRecordSchema.parse(FULL_ROW);
		expect(Object.keys(row).sort()).toEqual([
			"completion_condition",
			"created_at",
			"id",
			"status",
			"suggestion",
			"title",
			"updated_at",
		]);
		expect(row.completion_condition).toBe("");
		// A quest with no suggestion keeps a null or absent suggestion.
		expect(
			questInboxRecordSchema.parse({ ...FULL_ROW, suggestion: null }).suggestion
		).toBeNull();
	});

	test("every quests method of the host contract is behind the gate", () => {
		const contract = readFileSync(
			new URL(
				"../../../crates/core/kernel-contracts/schemas/host-api.json",
				import.meta.url
			),
			"utf8"
		);
		const verbs = [...contract.matchAll(QUEST_METHOD_ROW)].map(
			(match) => match[1] ?? ""
		);
		expect(verbs.length).toBe(15);
		expect(
			verbs
				.map((verb) => `quests${verb.charAt(0).toUpperCase()}${verb.slice(1)}`)
				.sort()
		).toEqual([...QUEST_VERBS].sort());
		expect(CALLS.map(([method]) => method).sort()).toEqual(
			verbs.map((verb) => `quests.${verb}`).sort()
		);
		for (const verb of QUEST_INBOX_VERBS) {
			expect(QUEST_VERBS).toContain(verb);
		}
	});
});
