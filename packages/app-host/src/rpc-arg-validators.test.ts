// Unit tests for the pure RPC argument validators in rpc.ts (the `as*Arg`
// narrowing family, lines ~3485-4394). These are the host's server-side input
// gate: every plugin/widget RPC arg is narrowed here BEFORE it reaches a Core
// service, so a narrowing bug is a security bug (a malformed nav call opening a
// tab, a bad shape forwarded to Core, an over-broad array reaching the mailer).
//
// DOM-free by design — these are all pure functions over `unknown`. The suite
// deliberately does NOT re-test the ~10 validators `rpc-validators.test.ts`
// already covers (asComposioArg / asMediaImageArg / asMediaTtsArg /
// asWorkflowRunArg / asWorkflowResumeArg / asRouteClaim / asDisplayModeArg /
// asOpenExternalArg / asPromptArg / asShellOpenTabArg). It spends its assertions
// on the branches where a narrowing bug would actually live: optional tri-state
// fields, array validation, nested delegation, tagged unions, closed sets, and
// verbatim-forwarding of unknown fields.

import { describe, expect, it } from "bun:test";
import {
	asActivityListArg,
	asActivitySessionArg,
	asApprovalDecideArg,
	asAssetQueryArg,
	asAssistantContextArg,
	asAssistantOpenArg,
	asAssistantSurfaceArg,
	asBlueprintRequestArg,
	asCalendarCreateAutomationArg,
	asChatSendArg,
	asFinetuneIdArg,
	asMailCreateArg,
	asMailIdArg,
	asMailInboxRefArg,
	asMailSendArg,
	asMediaTranscribeArg,
	asMediaVideoArg,
	asMeetingIdArg,
	asMeetingOpenArg,
	asMeetingOpenNotesArg,
	asMeetingRenameArg,
	asMeetingStartArg,
	asMonitorIdArg,
	asMonitorInputArg,
	asMonitorListLimitArg,
	asMonitorUpdateArg,
	asOpenInChatArg,
	asQuestIdArg,
	asQuestInputArg,
	asQuestUpdateArg,
	asReasoningRequestArg,
	asRecordArg,
	asRecordStartArg,
	asSkillDraftArg,
	asSkillIdArg,
	asSkillSnapshotArg,
	asSkillTitleArg,
	asSkillUpdateArg,
	asSkillVersionRefArg,
	asSocialRequestArg,
	asSpacesListArg,
	asSubtitlesRequestArg,
	asSuggestionFeedbackArg,
	asTemplateInstallArg,
	asTimelineFrameArg,
	asTimelineJournalArg,
	asTimelineRangeArg,
	asWorkflowIdArg,
	asWorkflowRunIdArg,
	asWorkflowVersionCreateArg,
	asWorkflowVersionGetArg,
} from "./rpc.ts";

describe("Chat Broadcast send validator", () => {
	it("accepts bounded text and trims only the conversation id", () => {
		expect(
			asChatSendArg({ conversationId: "  conv-1  ", text: " Stop now " })
		).toEqual({ conversationId: "conv-1", text: " Stop now " });
	});

	it("rejects missing, blank, oversized, and non-object input", () => {
		expect(asChatSendArg(null)).toBeNull();
		expect(asChatSendArg([])).toBeNull();
		expect(asChatSendArg({ conversationId: "", text: "x" })).toBeNull();
		expect(asChatSendArg({ conversationId: "conv", text: "   " })).toBeNull();
		expect(asChatSendArg({ conversationId: "conv" })).toBeNull();
		expect(
			asChatSendArg({ conversationId: "conv", text: "x".repeat(8001) })
		).toBeNull();
		expect(
			asChatSendArg({ conversationId: "x".repeat(201), text: "ok" })
		).toBeNull();
	});
});

// ── The `{ id: string }` (and single-required-string) family ────────────────────
//
// Many verbs share the same guard: reject non-objects, reject a missing/empty/
// non-string required field, accept an exact `{ id }`. One representative
// reject-path assertion each earns its keep (these gate nav + delete + Core reads)
// without multiplying identical variants.

describe("single-required-string validators reject the empty/missing/wrong-type paths", () => {
	const cases: {
		name: string;
		fn: (d: unknown) => unknown;
		field: string;
		good: Record<string, unknown>;
	}[] = [
		{
			name: "asSpacesListArg",
			fn: asSpacesListArg,
			field: "space_id",
			good: { space_id: "s1" },
		},
		{
			name: "asFinetuneIdArg",
			fn: asFinetuneIdArg,
			field: "id",
			good: { id: "ft1" },
		},
		{
			name: "asMonitorIdArg",
			fn: asMonitorIdArg,
			field: "id",
			good: { id: "m1" },
		},
		{ name: "asQuestIdArg", fn: asQuestIdArg, field: "id", good: { id: "q1" } },
		{
			name: "asMailIdArg",
			fn: asMailIdArg,
			field: "id",
			good: { id: "mail1" },
		},
		{
			name: "asMailInboxRefArg",
			fn: asMailInboxRefArg,
			field: "inboxId",
			good: { inboxId: "in1" },
		},
		{
			name: "asMeetingIdArg",
			fn: asMeetingIdArg,
			field: "id",
			good: { id: "mt1" },
		},
		{
			name: "asSkillIdArg",
			fn: asSkillIdArg,
			field: "id",
			good: { id: "sk1" },
		},
		{
			name: "asSkillTitleArg",
			fn: asSkillTitleArg,
			field: "title",
			good: { title: "T" },
		},
		{
			name: "asTemplateInstallArg",
			fn: asTemplateInstallArg,
			field: "templateId",
			good: { templateId: "tpl" },
		},
		{
			name: "asWorkflowIdArg",
			fn: asWorkflowIdArg,
			field: "id",
			good: { id: "wf1" },
		},
		{
			name: "asWorkflowRunIdArg",
			fn: asWorkflowRunIdArg,
			field: "runId",
			good: { runId: "run1" },
		},
		{
			name: "asActivitySessionArg",
			fn: asActivitySessionArg,
			field: "session_id",
			good: { session_id: "sess1" },
		},
	];

	for (const { name, fn, field, good } of cases) {
		it(`${name}: accepts a valid arg, rejects null/empty/missing/non-string`, () => {
			expect(fn(good)).toEqual(good);
			expect(fn(null)).toBeNull();
			expect(fn("nope")).toBeNull();
			expect(fn({})).toBeNull();
			expect(fn({ [field]: "" })).toBeNull();
			expect(fn({ [field]: 42 })).toBeNull();
		});
	}
});

// ── Verbatim-forwarding validators: unknown fields survive ──────────────────────

describe("verbatim-forwarding validators keep unknown fields and reject arrays", () => {
	it("asRecordArg forwards a plain object as-is, rejects null/array/non-object", () => {
		const obj = { a: 1, nested: { b: 2 } };
		expect(asRecordArg(obj)).toBe(obj); // same reference, verbatim
		expect(asRecordArg(null)).toBeNull();
		expect(asRecordArg([1, 2])).toBeNull();
		expect(asRecordArg("s")).toBeNull();
	});

	it("asMonitorInputArg validates the canonical model and forwards extras", () => {
		const good = {
			backend: "http" as const,
			check: { type: "uptime" as const },
			enabled: true,
			interval: "10m",
			name: "site",
			notify: [],
			url: "https://x.example.com",
			extra: 9,
		};
		expect(asMonitorInputArg(good)).toBe(good);
		for (const target of [
			{ kind: "webhook", url: "https://hooks.example" },
			{ kind: "telegram", bot_token: "bot", chat_id: "chat" },
			{ kind: "expo_push", token: "ExponentPushToken[x]" },
			{ kind: "email", to: "alerts@example.com" },
		]) {
			expect(asMonitorInputArg({ ...good, notify: [target] })).not.toBeNull();
		}
		for (const notify of [
			[{ kind: "email" }],
			[{ kind: "telegram", bot_token: "bot" }],
			[{ kind: "unknown", value: "x" }],
		]) {
			expect(asMonitorInputArg({ ...good, notify })).toBeNull();
		}
		expect(asMonitorInputArg({ name: "site" })).toBeNull(); // url missing
		expect(asMonitorInputArg({ url: "https://x" })).toBeNull(); // name missing
		expect(asMonitorInputArg({ name: 1, url: "u" })).toBeNull();
		expect(asMonitorInputArg([])).toBeNull();
	});

	it("asMailCreateArg requires name+address strings, forwards provider/unknown", () => {
		const good = {
			name: "Inbox",
			address: "a@b.co",
			provider: "resend",
			extra: true,
		};
		expect(asMailCreateArg(good)).toBe(good);
		expect(asMailCreateArg({ name: "n" })).toBeNull(); // address missing
		expect(asMailCreateArg({ name: 1, address: "a" })).toBeNull();
		expect(asMailCreateArg([])).toBeNull();
	});

	it("asQuestInputArg requires title+completion_condition strings and forwards extras", () => {
		const good = { title: "T", completion_condition: "done when X", reward: 5 };
		expect(asQuestInputArg(good)).toBe(good);
		expect(asQuestInputArg({ title: "T" })).toBeNull(); // completion_condition missing
		expect(asQuestInputArg({ title: 1, completion_condition: "c" })).toBeNull();
		expect(asQuestInputArg([])).toBeNull();
	});
});

// ── Nested delegation: an invalid inner payload rejects the whole arg ────────────

describe("nested-delegation validators reject on a bad inner payload", () => {
	it("asMonitorUpdateArg rejects when the nested input fails asMonitorInputArg", () => {
		const input = {
			backend: "http" as const,
			check: { type: "uptime" as const },
			enabled: true,
			interval: "10m",
			name: "s",
			notify: [],
			url: "u",
		};
		expect(asMonitorUpdateArg({ id: "m1", input })).toEqual({
			id: "m1",
			input,
		});
		expect(
			asMonitorUpdateArg({ id: "m1", input: { ...input, url: undefined } })
		).toBeNull(); // url missing
		expect(asMonitorUpdateArg({ id: "", input })).toBeNull();
		expect(asMonitorUpdateArg({ id: "m1" })).toBeNull(); // input missing
	});

	it("asQuestUpdateArg rejects when the nested input fails asQuestInputArg", () => {
		const input = { title: "T", completion_condition: "c" };
		expect(asQuestUpdateArg({ id: "q1", input })).toEqual({ id: "q1", input });
		expect(asQuestUpdateArg({ id: "q1", input: { title: "T" } })).toBeNull();
		expect(asQuestUpdateArg({ id: "", input })).toBeNull();
	});

	it("asSkillUpdateArg requires id AND a valid draft (delegates to pickSkillDraft)", () => {
		expect(asSkillUpdateArg({ id: "s1", name: "n", body: "b" })).toEqual({
			id: "s1",
			name: "n",
			body: "b",
		});
		expect(asSkillUpdateArg({ id: "s1", name: "n" })).toBeNull(); // body missing → draft null
		expect(asSkillUpdateArg({ id: "", name: "n", body: "b" })).toBeNull();
		expect(asSkillUpdateArg([])).toBeNull();
	});
});

// ── Optional tri-state fields (optionalString / optionalNonNegNumber) ────────────

describe("optional-field validators: present kept, wrong-type rejects whole arg, absent omitted", () => {
	it("asMediaVideoArg keeps valid optionals, drops absent, rejects wrong-typed", () => {
		expect(asMediaVideoArg({ prompt: "p" })).toEqual({ prompt: "p" });
		expect(
			asMediaVideoArg({ prompt: "p", provider: "sora", model: "v1" })
		).toEqual({
			prompt: "p",
			provider: "sora",
			model: "v1",
		});
		expect(asMediaVideoArg({ prompt: "" })).toBeNull(); // empty prompt rejected
		expect(asMediaVideoArg({ prompt: "p", provider: 9 })).toBeNull(); // wrong-type optional → whole null
		expect(asMediaVideoArg(null)).toBeNull();
	});

	it("asMediaTranscribeArg requires non-empty audio, optional filename", () => {
		expect(asMediaTranscribeArg({ audio: "data:..." })).toEqual({
			audio: "data:...",
		});
		expect(asMediaTranscribeArg({ audio: "a", filename: "clip.wav" })).toEqual({
			audio: "a",
			filename: "clip.wav",
		});
		expect(asMediaTranscribeArg({ audio: "" })).toBeNull();
		expect(asMediaTranscribeArg({ audio: "a", filename: 5 })).toBeNull();
	});

	it("asMonitorListLimitArg drops absent limit, rejects negative/non-finite", () => {
		expect(asMonitorListLimitArg({ id: "m1" })).toEqual({ id: "m1" });
		expect(asMonitorListLimitArg({ id: "m1", limit: 20 })).toEqual({
			id: "m1",
			limit: 20,
		});
		expect(asMonitorListLimitArg({ id: "m1", limit: 0 })).toEqual({
			id: "m1",
			limit: 0,
		});
		expect(asMonitorListLimitArg({ id: "m1", limit: -1 })).toBeNull(); // negative → whole null
		expect(
			asMonitorListLimitArg({ id: "m1", limit: Number.POSITIVE_INFINITY })
		).toBeNull();
		expect(asMonitorListLimitArg({ id: "", limit: 5 })).toBeNull();
	});

	it("asWorkflowVersionCreateArg keeps a string label, drops absent, rejects non-string", () => {
		expect(asWorkflowVersionCreateArg({ id: "w1" })).toEqual({ id: "w1" });
		expect(asWorkflowVersionCreateArg({ id: "w1", label: "v2" })).toEqual({
			id: "w1",
			label: "v2",
		});
		expect(asWorkflowVersionCreateArg({ id: "w1", label: 3 })).toBeNull();
	});

	it("asApprovalDecideArg drops a non-string note (never forwards a bad shape)", () => {
		expect(asApprovalDecideArg({ id: "a1" })).toEqual({ id: "a1" });
		expect(asApprovalDecideArg({ id: "a1", note: "looks fine" })).toEqual({
			id: "a1",
			note: "looks fine",
		});
		expect(asApprovalDecideArg({ id: "a1", note: 42 })).toEqual({ id: "a1" }); // dropped, not rejected
		expect(asApprovalDecideArg({ id: "" })).toBeNull();
	});

	it("asSkillSnapshotArg keeps a string label, drops a non-string one", () => {
		expect(asSkillSnapshotArg({ id: "s1" })).toEqual({ id: "s1" });
		expect(asSkillSnapshotArg({ id: "s1", label: "snap" })).toEqual({
			id: "s1",
			label: "snap",
		});
		expect(asSkillSnapshotArg({ id: "s1", label: 1 })).toEqual({ id: "s1" }); // dropped
	});
});

// ── Numeric finiteness guards ───────────────────────────────────────────────────

describe("numeric validators require finite numbers", () => {
	it("asTimelineRangeArg accepts a finite number, rejects NaN/Infinity/non-number", () => {
		expect(asTimelineRangeArg({ rangeMinutes: 60 })).toEqual({
			rangeMinutes: 60,
		});
		expect(asTimelineRangeArg({ rangeMinutes: Number.NaN })).toBeNull();
		expect(
			asTimelineRangeArg({ rangeMinutes: Number.POSITIVE_INFINITY })
		).toBeNull();
		expect(asTimelineRangeArg({ rangeMinutes: "60" })).toBeNull();
	});

	it("asTimelineFrameArg requires a finite tsMicros", () => {
		expect(asTimelineFrameArg({ tsMicros: 123 })).toEqual({ tsMicros: 123 });
		expect(asTimelineFrameArg({ tsMicros: Number.NaN })).toBeNull();
		expect(asTimelineFrameArg({})).toBeNull();
	});

	it("asTimelineJournalArg requires finite rangeMinutes but only DROPS a non-bool narrate", () => {
		expect(asTimelineJournalArg({ rangeMinutes: 30 })).toEqual({
			rangeMinutes: 30,
		});
		expect(asTimelineJournalArg({ rangeMinutes: 30, narrate: true })).toEqual({
			rangeMinutes: 30,
			narrate: true,
		});
		// A non-bool narrate is dropped (defaults off), NOT a whole-arg rejection.
		expect(asTimelineJournalArg({ rangeMinutes: 30, narrate: "yes" })).toEqual({
			rangeMinutes: 30,
		});
		expect(
			asTimelineJournalArg({ rangeMinutes: Number.NaN, narrate: true })
		).toBeNull();
	});
});

// ── Never-null shape-normalizers (the arg is optional; garbage → {} default) ─────

describe("optional-arg validators always return a well-formed object", () => {
	it("asActivityListArg returns {} for garbage and {limit} only for a finite number", () => {
		expect(asActivityListArg({ limit: 10 })).toEqual({ limit: 10 });
		expect(asActivityListArg({})).toEqual({});
		expect(asActivityListArg(null)).toEqual({});
		expect(asActivityListArg("x")).toEqual({});
		expect(asActivityListArg({ limit: Number.NaN })).toEqual({}); // non-finite dropped
		expect(asActivityListArg({ limit: "5" })).toEqual({});
	});

	it("asMeetingStartArg picks only valid string fields, dropping the rest", () => {
		expect(
			asMeetingStartArg({ source: "zoom", app: "Zoom", title: "Sync" })
		).toEqual({
			source: "zoom",
			app: "Zoom",
			title: "Sync",
		});
		expect(asMeetingStartArg({ source: 1, app: "Zoom" })).toEqual({
			app: "Zoom",
		});
		expect(asMeetingStartArg(null)).toEqual({});
		expect(asMeetingStartArg("bad")).toEqual({});
	});
});

// ── Array validation: asMailSendArg `to` must be a non-empty array of strings ─────

describe("asMailSendArg validates the recipient array (the over-broad-send guard)", () => {
	it("accepts a well-formed send with an optional text body", () => {
		expect(
			asMailSendArg({
				inboxId: "in1",
				to: ["a@b.co"],
				subject: "Hi",
				text: "body",
			})
		).toEqual({ inboxId: "in1", to: ["a@b.co"], subject: "Hi", text: "body" });
	});

	it("accepts an empty subject and omits an absent text", () => {
		expect(
			asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: "" })
		).toEqual({
			inboxId: "in1",
			to: ["a@b.co"],
			subject: "",
		});
	});

	it("rejects an empty recipient array, a non-string recipient, and a bad subject/text", () => {
		expect(asMailSendArg({ inboxId: "in1", to: [], subject: "s" })).toBeNull();
		expect(
			asMailSendArg({ inboxId: "in1", to: ["a@b.co", 5], subject: "s" })
		).toBeNull();
		expect(
			asMailSendArg({ inboxId: "in1", to: "a@b.co", subject: "s" })
		).toBeNull(); // not an array
		expect(
			asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: 9 })
		).toBeNull();
		expect(
			asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: "s", text: 9 })
		).toBeNull();
		expect(
			asMailSendArg({ inboxId: "", to: ["a@b.co"], subject: "s" })
		).toBeNull();
		expect(asMailSendArg([])).toBeNull();
	});
});

// ── Closed-set validation: asSuggestionFeedbackArg ──────────────────────────────

describe("asSuggestionFeedbackArg gates kind against the closed set", () => {
	it("accepts each allowed kind with a suggestion_type", () => {
		for (const kind of ["thumbs_up", "thumbs_down", "dismiss"] as const) {
			expect(
				asSuggestionFeedbackArg({ kind, suggestion_type: "reminder" })
			).toEqual({
				kind,
				suggestion_type: "reminder",
			});
		}
	});

	it("rejects an out-of-set kind or a missing suggestion_type", () => {
		expect(
			asSuggestionFeedbackArg({ kind: "thumbs_sideways", suggestion_type: "x" })
		).toBeNull();
		expect(asSuggestionFeedbackArg({ kind: "thumbs_up" })).toBeNull();
		expect(
			asSuggestionFeedbackArg({ kind: "thumbs_up", suggestion_type: 5 })
		).toBeNull();
		expect(asSuggestionFeedbackArg(null)).toBeNull();
	});
});

// ── Tagged-union validation: asCalendarCreateAutomationArg ──────────────────────

describe("asCalendarCreateAutomationArg validates the tagged schedule union", () => {
	const base = { agentId: "ag1", agentName: "Agent" };

	it("accepts a cron schedule", () => {
		expect(
			asCalendarCreateAutomationArg({
				...base,
				schedule: { kind: "cron", expr: "0 9 * * *" },
			})
		).toEqual({
			agentId: "ag1",
			agentName: "Agent",
			schedule: { kind: "cron", expr: "0 9 * * *" },
		});
	});

	it("accepts an every schedule and an explicit requireApproval", () => {
		expect(
			asCalendarCreateAutomationArg({
				...base,
				schedule: { kind: "every", interval: "1h" },
				requireApproval: true,
			})
		).toEqual({
			agentId: "ag1",
			agentName: "Agent",
			schedule: { kind: "every", interval: "1h" },
			requireApproval: true,
		});
	});

	it("accepts a persistent chat destination", () => {
		expect(
			asCalendarCreateAutomationArg({
				...base,
				conversationId: "conv-1",
				schedule: { kind: "cron", expr: "0 9 * * *" },
			})
		).toEqual({
			agentId: "ag1",
			agentName: "Agent",
			conversationId: "conv-1",
			schedule: { kind: "cron", expr: "0 9 * * *" },
		});
	});

	it("rejects an unknown schedule kind, a missing tag field, and a non-bool requireApproval", () => {
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: { kind: "weekly" } })
		).toBeNull();
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: { kind: "cron" } })
		).toBeNull(); // expr missing
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: { kind: "every" } })
		).toBeNull(); // interval missing
		expect(
			asCalendarCreateAutomationArg({
				...base,
				schedule: { kind: "cron", expr: "x" },
				requireApproval: "yes",
			})
		).toBeNull();
		expect(
			asCalendarCreateAutomationArg({
				...base,
				conversationId: 42,
				schedule: { kind: "cron", expr: "x" },
			})
		).toBeNull();
		expect(
			asCalendarCreateAutomationArg({
				...base,
				conversationId: "",
				schedule: { kind: "cron", expr: "x" },
			})
		).toBeNull();
		expect(
			asCalendarCreateAutomationArg({
				agentId: "",
				agentName: "A",
				schedule: { kind: "cron", expr: "x" },
			})
		).toBeNull();
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: null })
		).toBeNull();
		expect(asCalendarCreateAutomationArg([])).toBeNull();
	});
});

// ── Skill draft (pickSkillDraft via asSkillDraftArg): optional field handling ────

describe("asSkillDraftArg narrows the shared draft fields", () => {
	it("requires name+body, keeps optional description/allowedTools/alwaysOn", () => {
		expect(
			asSkillDraftArg({
				name: "greet",
				body: "# body",
				description: "says hi",
				allowedTools: ["Read", "Write"],
				alwaysOn: true,
			})
		).toEqual({
			name: "greet",
			body: "# body",
			description: "says hi",
			allowedTools: ["Read", "Write"],
			alwaysOn: true,
		});
	});

	it("preserves an explicit null description (a clear, not an omission)", () => {
		expect(
			asSkillDraftArg({ name: "n", body: "b", description: null })
		).toEqual({
			name: "n",
			body: "b",
			description: null,
		});
	});

	it("drops a non-string-array allowedTools and a non-bool alwaysOn", () => {
		expect(
			asSkillDraftArg({
				name: "n",
				body: "b",
				allowedTools: ["Read", 5],
				alwaysOn: "yes",
			})
		).toEqual({ name: "n", body: "b" }); // both invalid optionals dropped
	});

	it("rejects a missing name/body or an array/null root", () => {
		expect(asSkillDraftArg({ name: "n" })).toBeNull(); // body missing
		expect(asSkillDraftArg({ body: "b" })).toBeNull(); // name missing
		expect(asSkillDraftArg({ name: "", body: "b" })).toBeNull();
		expect(asSkillDraftArg([])).toBeNull();
		expect(asSkillDraftArg(null)).toBeNull();
	});
});

// ── Remaining two-field and edge validators ─────────────────────────────────────

describe("misc two-field validators", () => {
	it("asSkillVersionRefArg requires both id and versionId non-empty", () => {
		expect(asSkillVersionRefArg({ id: "s1", versionId: "v1" })).toEqual({
			id: "s1",
			versionId: "v1",
		});
		expect(asSkillVersionRefArg({ id: "s1", versionId: "" })).toBeNull();
		expect(asSkillVersionRefArg({ id: "s1" })).toBeNull();
	});

	it("asWorkflowVersionGetArg requires both id and versionId non-empty", () => {
		expect(asWorkflowVersionGetArg({ id: "w1", versionId: "v1" })).toEqual({
			id: "w1",
			versionId: "v1",
		});
		expect(asWorkflowVersionGetArg({ id: "", versionId: "v1" })).toBeNull();
		expect(asWorkflowVersionGetArg({ id: "w1", versionId: 3 })).toBeNull();
	});

	it("asMeetingRenameArg requires a non-empty id and a string title (empty allowed)", () => {
		expect(asMeetingRenameArg({ id: "mt1", title: "New" })).toEqual({
			id: "mt1",
			title: "New",
		});
		expect(asMeetingRenameArg({ id: "mt1", title: "" })).toEqual({
			id: "mt1",
			title: "",
		});
		expect(asMeetingRenameArg({ id: "mt1", title: 5 })).toBeNull();
		expect(asMeetingRenameArg({ id: "", title: "New" })).toBeNull();
	});

	it("asMeetingOpenArg keeps an optional string title", () => {
		expect(asMeetingOpenArg({ id: "mt1" })).toEqual({ id: "mt1" });
		expect(asMeetingOpenArg({ id: "mt1", title: "T" })).toEqual({
			id: "mt1",
			title: "T",
		});
		expect(asMeetingOpenArg({ id: "mt1", title: 9 })).toEqual({ id: "mt1" }); // non-string dropped
		expect(asMeetingOpenArg({ id: "" })).toBeNull();
	});

	it("asMeetingOpenNotesArg requires non-empty spaceId AND docId", () => {
		expect(
			asMeetingOpenNotesArg({ spaceId: "sp1", docId: "d1", title: "N" })
		).toEqual({
			spaceId: "sp1",
			docId: "d1",
			title: "N",
		});
		expect(asMeetingOpenNotesArg({ spaceId: "sp1", docId: "" })).toBeNull();
		expect(asMeetingOpenNotesArg({ spaceId: "", docId: "d1" })).toBeNull();
		expect(asMeetingOpenNotesArg({ docId: "d1" })).toBeNull();
	});
});

describe("string-shape validators that permit an empty value", () => {
	it("asAssetQueryArg accepts an EMPTY query (empty = trending), rejects non-string", () => {
		expect(asAssetQueryArg({ query: "" })).toEqual({ query: "" });
		expect(asAssetQueryArg({ query: "cats" })).toEqual({ query: "cats" });
		expect(asAssetQueryArg({ query: 5 })).toBeNull();
		expect(asAssetQueryArg({})).toBeNull();
		expect(asAssetQueryArg(null)).toBeNull();
	});

	it("asOpenInChatArg accepts any string prompt (empty allowed), rejects non-string", () => {
		expect(asOpenInChatArg({ prompt: "" })).toEqual({ prompt: "" });
		expect(asOpenInChatArg({ prompt: "go" })).toEqual({ prompt: "go" });
		expect(asOpenInChatArg({ prompt: 1 })).toBeNull();
	});

	it("asRecordStartArg accepts any string task (empty allowed), rejects non-string/null", () => {
		expect(asRecordStartArg({ task: "" })).toEqual({ task: "" });
		expect(asRecordStartArg({ task: "do X" })).toEqual({ task: "do X" });
		expect(asRecordStartArg({ task: 5 })).toBeNull();
		expect(asRecordStartArg(null)).toBeNull();
	});
});

describe("assistant bridge validators", () => {
	it("asAssistantContextArg drops malformed items and keeps the well-formed ones", () => {
		expect(
			asAssistantContextArg({
				items: [
					{ id: "a", title: "Board", text: "one widget" },
					{ id: "", title: "no id" },
					{ id: "b", title: "" },
					{ title: "no id at all" },
					"not an object",
					{ id: "c", title: "No text" },
				],
			})
		).toEqual({
			items: [
				{ id: "a", title: "Board", text: "one widget" },
				// A missing `text` is legitimate (a title-only chip), so it defaults
				// to "" rather than dropping the item.
				{ id: "c", title: "No text", text: "" },
			],
		});
	});

	it("asAssistantContextArg rejects a wrong ENVELOPE but never a wrong item", () => {
		expect(asAssistantContextArg(null)).toBeNull();
		expect(asAssistantContextArg({ items: "nope" })).toBeNull();
		expect(asAssistantContextArg({})).toBeNull();
		expect(asAssistantContextArg({ items: [] })).toEqual({ items: [] });
	});

	it("asAssistantContextArg caps item count and body length instead of failing", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			id: `i${i}`,
			title: "t",
			text: "x".repeat(20_000),
		}));
		const out = asAssistantContextArg({ items: many });
		expect(out?.items.length).toBe(8);
		expect(out?.items[0]?.text.length).toBe(8000);
	});

	it("asAssistantSurfaceArg requires a label — an unattributed takeover is refused", () => {
		expect(asAssistantSurfaceArg({ preamble: "do things" })).toBeNull();
		expect(asAssistantSurfaceArg({ label: "   " })).toBeNull();
		expect(asAssistantSurfaceArg(null)).toBeNull();
		expect(asAssistantSurfaceArg({ label: "Build board" })).toEqual({
			label: "Build board",
		});
	});

	it("asAssistantSurfaceArg keeps only well-typed optional fields", () => {
		expect(
			asAssistantSurfaceArg({
				label: "Board",
				description: "d",
				preamble: "p",
				tools: ["a", "", 5, "b"],
				prompts: [],
				extra: "ignored",
			})
		).toEqual({
			label: "Board",
			description: "d",
			preamble: "p",
			tools: ["a", "b"],
		});
	});

	it("asAssistantOpenArg treats no argument as a bare open", () => {
		expect(asAssistantOpenArg(undefined)).toEqual({});
		expect(asAssistantOpenArg(null)).toEqual({});
		expect(asAssistantOpenArg({})).toEqual({});
		expect(asAssistantOpenArg("floating")).toBeNull();
	});

	it("asAssistantOpenArg keeps a known mode + non-blank prompt only", () => {
		expect(asAssistantOpenArg({ mode: "sidebar", prompt: "why?" })).toEqual({
			mode: "sidebar",
			prompt: "why?",
		});
		expect(asAssistantOpenArg({ mode: "fullscreen", prompt: "  " })).toEqual(
			{}
		);
	});
});

// ── `social.request` — the one generic forwarder ────────────────────────────────
//
// This validator is the security boundary for a verb that carries the node bearer.
// A frame holding only `social:crud` supplies `path`; if that path can resolve
// outside `/api/social`, the frame reaches any API on the node with the host's
// credentials attached — and Core's own dot-segment guard never fires, because the
// request that leaves the desktop is already addressed to the escaped path.
describe("asSocialRequestArg", () => {
	it("keeps a normal sub-path, defaults the method, forwards the body verbatim", () => {
		expect(asSocialRequestArg({ path: "/posts?workspace_id=default" })).toEqual(
			{
				path: "/posts?workspace_id=default",
				method: "GET",
			}
		);
		expect(
			asSocialRequestArg({ path: "/posts", method: "POST", body: { a: 1 } })
		).toEqual({ path: "/posts", method: "POST", body: { a: 1 } });
	});

	it("rejects a path that is not a rooted sub-path", () => {
		expect(asSocialRequestArg({ path: "https://evil.example/x" })).toBeNull();
		expect(asSocialRequestArg({ path: "//evil.example/x" })).toBeNull();
		expect(asSocialRequestArg({ path: "posts" })).toBeNull();
		expect(asSocialRequestArg({ path: "/\\..\\settings" })).toBeNull();
		expect(asSocialRequestArg({ path: 42 })).toBeNull();
		expect(asSocialRequestArg(null)).toBeNull();
	});

	it("rejects a literal `..` climb out of the mount", () => {
		expect(asSocialRequestArg({ path: "/../plugins" })).toBeNull();
		expect(asSocialRequestArg({ path: "/posts/../../settings" })).toBeNull();
	});

	// The regression. `fetch` reads the WHATWG URL parser's output, not the raw
	// string, and that parser collapses every one of these into a `..` segment. A
	// literal-`..` blocklist passed them all: `/%2e%2e/settings` arrived at
	// `/api/settings`, and two levels escaped `/api/*` entirely.
	it("rejects a PERCENT-ENCODED climb, in every casing the URL parser folds", () => {
		for (const path of [
			"/%2e%2e/settings",
			"/%2E%2E/settings",
			"/.%2e/settings",
			"/%2e./settings",
			"/%2e%2e/%2e%2e/plugins/@ryu/social/host",
			"/posts/%2e%2e/%2e%2e/conversations",
		]) {
			expect(asSocialRequestArg({ path })).toBeNull();
		}
	});

	it("returns the NORMALIZED path, so nothing downstream re-derives a different one", () => {
		// A climb that stays inside the mount is legal, but what comes back is what
		// the parser resolved — never the frame's raw string.
		expect(asSocialRequestArg({ path: "/posts/%2e%2e/drafts" })).toEqual({
			path: "/drafts",
			method: "GET",
		});
		expect(asSocialRequestArg({ path: "/a/b/../../queue?limit=5" })).toEqual({
			path: "/queue?limit=5",
			method: "GET",
		});
	});

	it("refuses a method outside the closed set rather than downgrading it", () => {
		expect(asSocialRequestArg({ path: "/posts", method: "PUT" })).toBeNull();
		expect(asSocialRequestArg({ path: "/posts", method: "get" })).toBeNull();
	});
});

describe("asReasoningRequestArg", () => {
	it("keeps a normal sub-path, defaults the method, forwards the body verbatim", () => {
		expect(asReasoningRequestArg({ path: "/policies" })).toEqual({
			path: "/policies",
			method: "GET",
		});
		expect(
			asReasoningRequestArg({
				path: "/check",
				method: "POST",
				body: { policy_id: "hr" },
			})
		).toEqual({ path: "/check", method: "POST", body: { policy_id: "hr" } });
	});

	it("rejects a path that is not a rooted sub-path", () => {
		expect(
			asReasoningRequestArg({ path: "https://evil.example/x" })
		).toBeNull();
		expect(asReasoningRequestArg({ path: "//evil.example/x" })).toBeNull();
		expect(asReasoningRequestArg({ path: "policies" })).toBeNull();
		expect(asReasoningRequestArg({ path: "/\\..\\settings" })).toBeNull();
		expect(asReasoningRequestArg({ path: 42 })).toBeNull();
		expect(asReasoningRequestArg(null)).toBeNull();
	});

	// The same regression the Outpost forwarder was fixed for. Sharing
	// `resolveMountedRequestPath` is what makes these pass here without a second
	// implementation having to relearn it.
	it("rejects a climb out of the mount, literal and percent-encoded", () => {
		for (const path of [
			"/../plugins",
			"/policies/../../settings",
			"/%2e%2e/settings",
			"/%2E%2E/settings",
			"/.%2e/settings",
			"/%2e./settings",
			"/policies/%2e%2e/%2e%2e/conversations",
		]) {
			expect(asReasoningRequestArg({ path })).toBeNull();
		}
	});

	it("returns the NORMALIZED path, so nothing downstream re-derives a different one", () => {
		expect(asReasoningRequestArg({ path: "/policies/%2e%2e/check" })).toEqual({
			path: "/check",
			method: "GET",
		});
	});

	it("serves PUT (the policy-update verb) and refuses anything outside the set", () => {
		expect(
			asReasoningRequestArg({ path: "/policies/hr", method: "PUT" })
		).toEqual({
			path: "/policies/hr",
			method: "PUT",
		});
		expect(
			asReasoningRequestArg({ path: "/policies", method: "PATCH" })
		).toBeNull();
		expect(
			asReasoningRequestArg({ path: "/policies", method: "get" })
		).toBeNull();
	});
});

describe("asSubtitlesRequestArg", () => {
	it("keeps a normal sub-path, defaults the method, forwards the body verbatim", () => {
		expect(asSubtitlesRequestArg({ path: "/jobs" })).toEqual({
			path: "/jobs",
			method: "GET",
		});
		expect(
			asSubtitlesRequestArg({
				path: "/jobs",
				method: "POST",
				body: { source_path: "/Users/x/Movies/film.mkv" },
			})
		).toEqual({
			path: "/jobs",
			method: "POST",
			body: { source_path: "/Users/x/Movies/film.mkv" },
		});
	});

	it("keeps a query string, which the library browser depends on", () => {
		expect(
			asSubtitlesRequestArg({ path: "/library?dir=%2FUsers%2Fx%2FMovies" })
		).toEqual({ path: "/library?dir=%2FUsers%2Fx%2FMovies", method: "GET" });
	});

	it("rejects a path that is not a rooted sub-path", () => {
		expect(
			asSubtitlesRequestArg({ path: "https://evil.example/x" })
		).toBeNull();
		expect(asSubtitlesRequestArg({ path: "//evil.example/x" })).toBeNull();
		expect(asSubtitlesRequestArg({ path: "jobs" })).toBeNull();
		expect(asSubtitlesRequestArg({ path: "/\\..\\settings" })).toBeNull();
		expect(asSubtitlesRequestArg({ path: 42 })).toBeNull();
		expect(asSubtitlesRequestArg(null)).toBeNull();
	});

	// The same regression the Outpost forwarder was fixed for. Sharing
	// `resolveMountedRequestPath` is what makes these pass here without a second
	// implementation having to relearn it.
	it("rejects a climb out of the mount, literal and percent-encoded", () => {
		for (const path of [
			"/../plugins",
			"/jobs/../../settings",
			"/%2e%2e/settings",
			"/%2E%2E/settings",
			"/.%2e/settings",
			"/%2e./settings",
			"/jobs/%2e%2e/%2e%2e/conversations",
		]) {
			expect(asSubtitlesRequestArg({ path })).toBeNull();
		}
	});

	it("returns the NORMALIZED path, so nothing downstream re-derives a different one", () => {
		expect(asSubtitlesRequestArg({ path: "/jobs/%2e%2e/settings" })).toEqual({
			path: "/settings",
			method: "GET",
		});
	});

	it("serves PUT (the settings verb) and refuses anything outside the set", () => {
		expect(asSubtitlesRequestArg({ path: "/settings", method: "PUT" })).toEqual(
			{
				path: "/settings",
				method: "PUT",
			}
		);
		expect(
			asSubtitlesRequestArg({ path: "/jobs", method: "PATCH" })
		).toBeNull();
		expect(asSubtitlesRequestArg({ path: "/jobs", method: "get" })).toBeNull();
	});
});

describe("asBlueprintRequestArg", () => {
	it("keeps a normal sub-path, defaults the method, forwards the body verbatim", () => {
		expect(asBlueprintRequestArg({ path: "/plans" })).toEqual({
			path: "/plans",
			method: "GET",
		});
		expect(
			asBlueprintRequestArg({
				path: "/plans/p_migrate/annotations",
				method: "POST",
				body: { kind: "blocker", target: { type: "step", id: "s_migrate" } },
			})
		).toEqual({
			path: "/plans/p_migrate/annotations",
			method: "POST",
			body: { kind: "blocker", target: { type: "step", id: "s_migrate" } },
		});
	});

	it("keeps the query string, which the plan list and the diff both need", () => {
		expect(asBlueprintRequestArg({ path: "/plans?status=in_review" })).toEqual({
			path: "/plans?status=in_review",
			method: "GET",
		});
		expect(
			asBlueprintRequestArg({ path: "/plans/p_x/diff?from=1&to=2" })
		).toEqual({ path: "/plans/p_x/diff?from=1&to=2", method: "GET" });
	});

	it("rejects a path that is not a rooted sub-path", () => {
		expect(
			asBlueprintRequestArg({ path: "https://evil.example/x" })
		).toBeNull();
		expect(asBlueprintRequestArg({ path: "//evil.example/x" })).toBeNull();
		expect(asBlueprintRequestArg({ path: "plans" })).toBeNull();
		expect(asBlueprintRequestArg({ path: "/\\..\\settings" })).toBeNull();
		expect(asBlueprintRequestArg({ path: 42 })).toBeNull();
		expect(asBlueprintRequestArg(null)).toBeNull();
	});

	// A plan id is the most attacker-adjacent string this verb ever sees: it comes
	// from whatever an agent passed to `plan_publish` and it lands mid-path in almost
	// every route. Sharing `resolveMountedRequestPath` is what makes the encoded forms
	// fail here without a second implementation having to relearn that a literal `..`
	// blocklist loses to the URL parser's own decoding.
	it("rejects a climb out of the mount, literal and percent-encoded", () => {
		for (const path of [
			"/../plugins",
			"/plans/../../settings",
			"/%2e%2e/settings",
			"/%2E%2E/settings",
			"/.%2e/settings",
			"/%2e./settings",
			"/plans/%2e%2e/%2e%2e/conversations",
		]) {
			expect(asBlueprintRequestArg({ path })).toBeNull();
		}
	});

	it("returns the NORMALIZED path, so nothing downstream re-derives a different one", () => {
		expect(asBlueprintRequestArg({ path: "/plans/%2e%2e/plans" })).toEqual({
			path: "/plans",
			method: "GET",
		});
	});

	// Three verbs, not four. The plan surface is append-only — revising a plan POSTs a
	// new revision rather than editing one — so a PUT reaching the sidecar would be a
	// 405, and advertising it here would only move the failure later.
	it("serves GET/POST/DELETE and refuses everything else", () => {
		expect(
			asBlueprintRequestArg({ path: "/plans/p_x", method: "DELETE" })
		).toEqual({ path: "/plans/p_x", method: "DELETE" });
		expect(asBlueprintRequestArg({ path: "/plans", method: "PUT" })).toBeNull();
		expect(
			asBlueprintRequestArg({ path: "/plans", method: "PATCH" })
		).toBeNull();
		expect(asBlueprintRequestArg({ path: "/plans", method: "get" })).toBeNull();
	});
});
