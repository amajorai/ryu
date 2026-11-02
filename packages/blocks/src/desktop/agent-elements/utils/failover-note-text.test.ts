import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { CloudTaskTranslate } from "./cloud-task-event-text.ts";
import {
	FAILOVER_PART_TYPE,
	failoverMarkerText,
	failoverNoteText,
} from "./failover-note-text.ts";

const OUT_OF = "{agent} has reached its {window} limit on your {plan} plan.";
const RETRYING = "Retrying on {agent}, which has {headroom}% left.";
const WAIT =
	"Every plan is out of room. The first to reopen is the {window} limit for {agent}, at {time} on {date}.";

/** A stand-in catalog: German wording for the failover sources. */
const german: CloudTaskTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[OUT_OF]: "{agent} hat das Limit „{window}“ deines {plan}-Tarifs erreicht.",
		[RETRYING]: "Neuer Versuch mit {agent}, das noch {headroom} % frei hat.",
		[WAIT]:
			"Alle Tarife sind ausgeschöpft. Als Erstes öffnet sich das Limit „{window}“ von {agent}, um {time} am {date}.",
	};
	return formatMessage(catalog[source] ?? source, values, "de");
};

const reroutePart = {
	data: {
		agent_id: "acp:codex",
		headroom_percent: 80,
		kind: "reroute",
		messages: [
			{
				args: { agent: "Claude", plan: "Max", window: "session" },
				message: OUT_OF,
			},
			{
				args: {
					agent: "Codex",
					headroom: { max_fraction: 0, min_fraction: 0, number: 80 },
				},
				message: RETRYING,
			},
		],
		note: "Claude has reached its session limit on your Max plan. Retrying on Codex, which has 80% left.",
	},
	type: FAILOVER_PART_TYPE,
};

test("renders a reroute note in the reader's language", () => {
	expect(failoverNoteText(reroutePart, german, "de")).toBe(
		"Claude hat das Limit „session“ deines Max-Tarifs erreicht. Neuer Versuch mit Codex, das noch 80 % frei hat."
	);
});

test("writes a wait's reset time from resets_at in the reader's locale", () => {
	const resetsAt = "2026-08-01T12:00:00Z";
	const part = {
		data: {
			kind: "wait",
			messages: [
				{
					args: {
						agent: "Claude",
						date: { date: "2026-08-01" },
						time: "12:00",
						window: "session",
					},
					message: WAIT,
				},
			],
			note: "Every plan is out of room.",
			resets_at: resetsAt,
		},
		type: FAILOVER_PART_TYPE,
	};
	const instant = new Date(resetsAt);
	const day = new Intl.DateTimeFormat("de", {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(instant);
	const time = new Intl.DateTimeFormat("de", {
		hour: "numeric",
		minute: "2-digit",
	}).format(instant);
	expect(failoverNoteText(part, german, "de")).toBe(
		`Alle Tarife sind ausgeschöpft. Als Erstes öffnet sich das Limit „session“ von Claude, um ${time} am ${day}.`
	);
});

test("a wait without a readable reset falls back to Core's note", () => {
	const part = {
		data: {
			kind: "wait",
			messages: [
				{
					args: { agent: "Claude", date: { date: "2026-08-01" }, time: "x" },
					message: WAIT,
				},
			],
			note: "Every plan is out of room.",
		},
		type: FAILOVER_PART_TYPE,
	};
	expect(failoverNoteText(part, german, "de")).toBeNull();
	expect(failoverMarkerText(part, "de")).toBe("Every plan is out of room.");
});

test("an older Core without messages keeps its note", () => {
	const part = {
		data: { kind: "held", note: "Codex still has 80% left." },
		type: FAILOVER_PART_TYPE,
	};
	expect(failoverMarkerText(part, "de")).toBe("Codex still has 80% left.");
	expect(failoverMarkerText({ text: "hi", type: "text" }, "de")).toBeNull();
});

const RETRY_JA = "{agent} で再試行します。残りは {headroom}% です。";
const OUT_OF_JA = "{agent} は {plan} プランの {window} の上限に達しました。";

/** A stand-in catalog: Japanese wording for the reroute sources. */
const japanese: CloudTaskTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[OUT_OF]: OUT_OF_JA,
		[RETRYING]: RETRY_JA,
	};
	return formatMessage(catalog[source] ?? source, values, "ja");
};

test("joins translated Japanese sentences without a space", () => {
	expect(failoverNoteText(reroutePart, japanese, "ja")).toBe(
		"Claude は Max プランの session の上限に達しました。Codex で再試行します。残りは 80% です。"
	);
});

test("writes an Arabic wait's day with Arabic names", () => {
	const part = {
		data: {
			kind: "wait",
			messages: [
				{
					args: {
						agent: "Claude",
						date: { date: "2026-08-01" },
						time: "12:00",
						window: "session",
					},
					message: WAIT,
				},
			],
			note: "Every plan is out of room.",
			resets_at: "2026-08-01T12:00:00Z",
		},
		type: FAILOVER_PART_TYPE,
	};
	const passthrough: CloudTaskTranslate = (source, values) =>
		formatMessage(source, values, "ar");
	const note = failoverNoteText(part, passthrough, "ar") ?? "";
	const day = new Intl.DateTimeFormat("ar", {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(new Date("2026-08-01T12:00:00Z"));
	expect(note).toContain(day);
	expect(note).not.toContain("August");
	expect(note).not.toContain("12:00 on");
});
