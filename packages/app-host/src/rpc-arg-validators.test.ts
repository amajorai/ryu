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
	asCalendarCreateAutomationArg,
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
	asRecordArg,
	asRecordStartArg,
	asSkillDraftArg,
	asSkillIdArg,
	asSkillSnapshotArg,
	asSkillTitleArg,
	asSkillUpdateArg,
	asSkillVersionRefArg,
	asSpacesListArg,
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
		{ name: "asSpacesListArg", fn: asSpacesListArg, field: "space_id", good: { space_id: "s1" } },
		{ name: "asFinetuneIdArg", fn: asFinetuneIdArg, field: "id", good: { id: "ft1" } },
		{ name: "asMonitorIdArg", fn: asMonitorIdArg, field: "id", good: { id: "m1" } },
		{ name: "asQuestIdArg", fn: asQuestIdArg, field: "id", good: { id: "q1" } },
		{ name: "asMailIdArg", fn: asMailIdArg, field: "id", good: { id: "mail1" } },
		{ name: "asMailInboxRefArg", fn: asMailInboxRefArg, field: "inboxId", good: { inboxId: "in1" } },
		{ name: "asMeetingIdArg", fn: asMeetingIdArg, field: "id", good: { id: "mt1" } },
		{ name: "asSkillIdArg", fn: asSkillIdArg, field: "id", good: { id: "sk1" } },
		{ name: "asSkillTitleArg", fn: asSkillTitleArg, field: "title", good: { title: "T" } },
		{ name: "asTemplateInstallArg", fn: asTemplateInstallArg, field: "templateId", good: { templateId: "tpl" } },
		{ name: "asWorkflowIdArg", fn: asWorkflowIdArg, field: "id", good: { id: "wf1" } },
		{ name: "asWorkflowRunIdArg", fn: asWorkflowRunIdArg, field: "runId", good: { runId: "run1" } },
		{ name: "asActivitySessionArg", fn: asActivitySessionArg, field: "session_id", good: { session_id: "sess1" } },
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

	it("asMonitorInputArg requires name+url strings and forwards extras", () => {
		const good = { name: "site", url: "https://x.example.com", check: { kind: "http" }, extra: 9 };
		expect(asMonitorInputArg(good)).toBe(good);
		expect(asMonitorInputArg({ name: "site" })).toBeNull(); // url missing
		expect(asMonitorInputArg({ url: "https://x" })).toBeNull(); // name missing
		expect(asMonitorInputArg({ name: 1, url: "u" })).toBeNull();
		expect(asMonitorInputArg([])).toBeNull();
	});

	it("asMailCreateArg requires name+address strings, forwards provider/unknown", () => {
		const good = { name: "Inbox", address: "a@b.co", provider: "resend", extra: true };
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
		expect(asMonitorUpdateArg({ id: "m1", input: { name: "s", url: "u" } })).toEqual({
			id: "m1",
			input: { name: "s", url: "u" },
		});
		expect(asMonitorUpdateArg({ id: "m1", input: { name: "s" } })).toBeNull(); // url missing
		expect(asMonitorUpdateArg({ id: "", input: { name: "s", url: "u" } })).toBeNull();
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
		expect(asMediaVideoArg({ prompt: "p", provider: "sora", model: "v1" })).toEqual({
			prompt: "p",
			provider: "sora",
			model: "v1",
		});
		expect(asMediaVideoArg({ prompt: "" })).toBeNull(); // empty prompt rejected
		expect(asMediaVideoArg({ prompt: "p", provider: 9 })).toBeNull(); // wrong-type optional → whole null
		expect(asMediaVideoArg(null)).toBeNull();
	});

	it("asMediaTranscribeArg requires non-empty audio, optional filename", () => {
		expect(asMediaTranscribeArg({ audio: "data:..." })).toEqual({ audio: "data:..." });
		expect(asMediaTranscribeArg({ audio: "a", filename: "clip.wav" })).toEqual({
			audio: "a",
			filename: "clip.wav",
		});
		expect(asMediaTranscribeArg({ audio: "" })).toBeNull();
		expect(asMediaTranscribeArg({ audio: "a", filename: 5 })).toBeNull();
	});

	it("asMonitorListLimitArg drops absent limit, rejects negative/non-finite", () => {
		expect(asMonitorListLimitArg({ id: "m1" })).toEqual({ id: "m1" });
		expect(asMonitorListLimitArg({ id: "m1", limit: 20 })).toEqual({ id: "m1", limit: 20 });
		expect(asMonitorListLimitArg({ id: "m1", limit: 0 })).toEqual({ id: "m1", limit: 0 });
		expect(asMonitorListLimitArg({ id: "m1", limit: -1 })).toBeNull(); // negative → whole null
		expect(asMonitorListLimitArg({ id: "m1", limit: Number.POSITIVE_INFINITY })).toBeNull();
		expect(asMonitorListLimitArg({ id: "", limit: 5 })).toBeNull();
	});

	it("asWorkflowVersionCreateArg keeps a string label, drops absent, rejects non-string", () => {
		expect(asWorkflowVersionCreateArg({ id: "w1" })).toEqual({ id: "w1" });
		expect(asWorkflowVersionCreateArg({ id: "w1", label: "v2" })).toEqual({ id: "w1", label: "v2" });
		expect(asWorkflowVersionCreateArg({ id: "w1", label: 3 })).toBeNull();
	});

	it("asApprovalDecideArg drops a non-string note (never forwards a bad shape)", () => {
		expect(asApprovalDecideArg({ id: "a1" })).toEqual({ id: "a1" });
		expect(asApprovalDecideArg({ id: "a1", note: "looks fine" })).toEqual({ id: "a1", note: "looks fine" });
		expect(asApprovalDecideArg({ id: "a1", note: 42 })).toEqual({ id: "a1" }); // dropped, not rejected
		expect(asApprovalDecideArg({ id: "" })).toBeNull();
	});

	it("asSkillSnapshotArg keeps a string label, drops a non-string one", () => {
		expect(asSkillSnapshotArg({ id: "s1" })).toEqual({ id: "s1" });
		expect(asSkillSnapshotArg({ id: "s1", label: "snap" })).toEqual({ id: "s1", label: "snap" });
		expect(asSkillSnapshotArg({ id: "s1", label: 1 })).toEqual({ id: "s1" }); // dropped
	});
});

// ── Numeric finiteness guards ───────────────────────────────────────────────────

describe("numeric validators require finite numbers", () => {
	it("asTimelineRangeArg accepts a finite number, rejects NaN/Infinity/non-number", () => {
		expect(asTimelineRangeArg({ rangeMinutes: 60 })).toEqual({ rangeMinutes: 60 });
		expect(asTimelineRangeArg({ rangeMinutes: Number.NaN })).toBeNull();
		expect(asTimelineRangeArg({ rangeMinutes: Number.POSITIVE_INFINITY })).toBeNull();
		expect(asTimelineRangeArg({ rangeMinutes: "60" })).toBeNull();
	});

	it("asTimelineFrameArg requires a finite tsMicros", () => {
		expect(asTimelineFrameArg({ tsMicros: 123 })).toEqual({ tsMicros: 123 });
		expect(asTimelineFrameArg({ tsMicros: Number.NaN })).toBeNull();
		expect(asTimelineFrameArg({})).toBeNull();
	});

	it("asTimelineJournalArg requires finite rangeMinutes but only DROPS a non-bool narrate", () => {
		expect(asTimelineJournalArg({ rangeMinutes: 30 })).toEqual({ rangeMinutes: 30 });
		expect(asTimelineJournalArg({ rangeMinutes: 30, narrate: true })).toEqual({
			rangeMinutes: 30,
			narrate: true,
		});
		// A non-bool narrate is dropped (defaults off), NOT a whole-arg rejection.
		expect(asTimelineJournalArg({ rangeMinutes: 30, narrate: "yes" })).toEqual({ rangeMinutes: 30 });
		expect(asTimelineJournalArg({ rangeMinutes: Number.NaN, narrate: true })).toBeNull();
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
		expect(asMeetingStartArg({ source: "zoom", app: "Zoom", title: "Sync" })).toEqual({
			source: "zoom",
			app: "Zoom",
			title: "Sync",
		});
		expect(asMeetingStartArg({ source: 1, app: "Zoom" })).toEqual({ app: "Zoom" });
		expect(asMeetingStartArg(null)).toEqual({});
		expect(asMeetingStartArg("bad")).toEqual({});
	});
});

// ── Array validation: asMailSendArg `to` must be a non-empty array of strings ─────

describe("asMailSendArg validates the recipient array (the over-broad-send guard)", () => {
	it("accepts a well-formed send with an optional text body", () => {
		expect(
			asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: "Hi", text: "body" })
		).toEqual({ inboxId: "in1", to: ["a@b.co"], subject: "Hi", text: "body" });
	});

	it("accepts an empty subject and omits an absent text", () => {
		expect(asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: "" })).toEqual({
			inboxId: "in1",
			to: ["a@b.co"],
			subject: "",
		});
	});

	it("rejects an empty recipient array, a non-string recipient, and a bad subject/text", () => {
		expect(asMailSendArg({ inboxId: "in1", to: [], subject: "s" })).toBeNull();
		expect(asMailSendArg({ inboxId: "in1", to: ["a@b.co", 5], subject: "s" })).toBeNull();
		expect(asMailSendArg({ inboxId: "in1", to: "a@b.co", subject: "s" })).toBeNull(); // not an array
		expect(asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: 9 })).toBeNull();
		expect(asMailSendArg({ inboxId: "in1", to: ["a@b.co"], subject: "s", text: 9 })).toBeNull();
		expect(asMailSendArg({ inboxId: "", to: ["a@b.co"], subject: "s" })).toBeNull();
		expect(asMailSendArg([])).toBeNull();
	});
});

// ── Closed-set validation: asSuggestionFeedbackArg ──────────────────────────────

describe("asSuggestionFeedbackArg gates kind against the closed set", () => {
	it("accepts each allowed kind with a suggestion_type", () => {
		for (const kind of ["thumbs_up", "thumbs_down", "dismiss"]) {
			expect(asSuggestionFeedbackArg({ kind, suggestion_type: "reminder" })).toEqual({
				kind,
				suggestion_type: "reminder",
			});
		}
	});

	it("rejects an out-of-set kind or a missing suggestion_type", () => {
		expect(asSuggestionFeedbackArg({ kind: "thumbs_sideways", suggestion_type: "x" })).toBeNull();
		expect(asSuggestionFeedbackArg({ kind: "thumbs_up" })).toBeNull();
		expect(asSuggestionFeedbackArg({ kind: "thumbs_up", suggestion_type: 5 })).toBeNull();
		expect(asSuggestionFeedbackArg(null)).toBeNull();
	});
});

// ── Tagged-union validation: asCalendarCreateAutomationArg ──────────────────────

describe("asCalendarCreateAutomationArg validates the tagged schedule union", () => {
	const base = { agentId: "ag1", agentName: "Agent" };

	it("accepts a cron schedule", () => {
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: { kind: "cron", expr: "0 9 * * *" } })
		).toEqual({ agentId: "ag1", agentName: "Agent", schedule: { kind: "cron", expr: "0 9 * * *" } });
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

	it("rejects an unknown schedule kind, a missing tag field, and a non-bool requireApproval", () => {
		expect(asCalendarCreateAutomationArg({ ...base, schedule: { kind: "weekly" } })).toBeNull();
		expect(asCalendarCreateAutomationArg({ ...base, schedule: { kind: "cron" } })).toBeNull(); // expr missing
		expect(asCalendarCreateAutomationArg({ ...base, schedule: { kind: "every" } })).toBeNull(); // interval missing
		expect(
			asCalendarCreateAutomationArg({ ...base, schedule: { kind: "cron", expr: "x" }, requireApproval: "yes" })
		).toBeNull();
		expect(asCalendarCreateAutomationArg({ agentId: "", agentName: "A", schedule: { kind: "cron", expr: "x" } })).toBeNull();
		expect(asCalendarCreateAutomationArg({ ...base, schedule: null })).toBeNull();
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
		expect(asSkillDraftArg({ name: "n", body: "b", description: null })).toEqual({
			name: "n",
			body: "b",
			description: null,
		});
	});

	it("drops a non-string-array allowedTools and a non-bool alwaysOn", () => {
		expect(
			asSkillDraftArg({ name: "n", body: "b", allowedTools: ["Read", 5], alwaysOn: "yes" })
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
		expect(asSkillVersionRefArg({ id: "s1", versionId: "v1" })).toEqual({ id: "s1", versionId: "v1" });
		expect(asSkillVersionRefArg({ id: "s1", versionId: "" })).toBeNull();
		expect(asSkillVersionRefArg({ id: "s1" })).toBeNull();
	});

	it("asWorkflowVersionGetArg requires both id and versionId non-empty", () => {
		expect(asWorkflowVersionGetArg({ id: "w1", versionId: "v1" })).toEqual({ id: "w1", versionId: "v1" });
		expect(asWorkflowVersionGetArg({ id: "", versionId: "v1" })).toBeNull();
		expect(asWorkflowVersionGetArg({ id: "w1", versionId: 3 })).toBeNull();
	});

	it("asMeetingRenameArg requires a non-empty id and a string title (empty allowed)", () => {
		expect(asMeetingRenameArg({ id: "mt1", title: "New" })).toEqual({ id: "mt1", title: "New" });
		expect(asMeetingRenameArg({ id: "mt1", title: "" })).toEqual({ id: "mt1", title: "" });
		expect(asMeetingRenameArg({ id: "mt1", title: 5 })).toBeNull();
		expect(asMeetingRenameArg({ id: "", title: "New" })).toBeNull();
	});

	it("asMeetingOpenArg keeps an optional string title", () => {
		expect(asMeetingOpenArg({ id: "mt1" })).toEqual({ id: "mt1" });
		expect(asMeetingOpenArg({ id: "mt1", title: "T" })).toEqual({ id: "mt1", title: "T" });
		expect(asMeetingOpenArg({ id: "mt1", title: 9 })).toEqual({ id: "mt1" }); // non-string dropped
		expect(asMeetingOpenArg({ id: "" })).toBeNull();
	});

	it("asMeetingOpenNotesArg requires non-empty spaceId AND docId", () => {
		expect(asMeetingOpenNotesArg({ spaceId: "sp1", docId: "d1", title: "N" })).toEqual({
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
