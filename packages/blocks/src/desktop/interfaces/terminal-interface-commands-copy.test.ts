import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; this test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import {
	explainUnknown,
	startThread,
	statusNoticeSegments,
} from "./terminal-interface-commands.ts";
import type { NewEntry } from "./terminal-interface-entries.ts";

const JA: Record<string, string> = {
	"filters: {filters}": "フィルター: {filters}",
	'ls: unknown filter "{filter}"': "ls: 不明なフィルター「{filter}」",
	"new: missing message": "new: メッセージがありません",
	"open: which thread?": "open: どのスレッドですか?",
	"ryu: command not found: {command}":
		"ryu: コマンドが見つかりません: {command}",
	"try {command}": "{command} を試してください",
	"usage: new [@agent] <message>": "使い方: new [@agent] <メッセージ>",
	"{title} is now {status}": "{title} の状態: {status}",
};

const jaTl: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values ?? {}, "ja");

const runtime = {
	direction: "ltr" as const,
	locale: "ja",
	translate: (_id: string, values?: MessageValuesInput, fallback = "") =>
		formatMessage(JA[fallback] ?? fallback, values ?? {}, "ja"),
};

afterEach(() => unregisterActiveI18nRuntime(runtime));

function texts(entries: NewEntry[]): string[] {
	return entries.map((entry) =>
		"segments" in entry
			? entry.segments.map((segment) => segment.text).join("")
			: ""
	);
}

function collect(): { entries: NewEntry[]; push: (...e: NewEntry[]) => void } {
	const entries: NewEntry[] = [];
	return { entries, push: (...blocks) => entries.push(...blocks) };
}

describe("terminal command lines", () => {
	test("unknown commands explain themselves in Japanese, command words kept", () => {
		registerActiveI18nRuntime(runtime);
		const ls = collect();
		explainUnknown(ls.push, "ls nope");
		expect(texts(ls.entries)).toEqual([
			"ls: 不明なフィルター「nope」",
			"フィルター: all, working, your-turn, waiting, attention, quiet",
		]);
		const open = collect();
		explainUnknown(open.push, "open");
		expect(texts(open.entries)[0]).toBe("open: どのスレッドですか?");
		const other = collect();
		explainUnknown(other.push, "frob");
		expect(texts(other.entries)).toEqual([
			"ryu: コマンドが見つかりません: frob",
			"help を試してください",
		]);
	});

	test("a new thread without a message prints translated usage", () => {
		const out = collect();
		startThread(
			{
				port: {} as InterfacePort,
				push: out.push,
				snapshot: {} as InterfaceSnapshot,
				tl: jaTl,
			},
			null,
			"  "
		);
		expect(texts(out.entries)).toEqual([
			"new: メッセージがありません",
			"使い方: new [@agent] <メッセージ>",
		]);
	});

	test("the status notice keeps both values emphasised in the locale's order", () => {
		const segments = statusNoticeSegments(
			jaTl,
			{ text: "Build", tone: "primary" },
			{ text: "作業中", tone: "success" }
		);
		expect(segments.map((segment) => segment.text).join("")).toBe(
			"Build の状態: 作業中"
		);
		expect(segments[0]).toEqual({ text: "Build", tone: "primary" });
		expect(segments.at(-1)).toEqual({ text: "作業中", tone: "success" });
		const english = statusNoticeSegments(
			(source, values) => formatMessage(source, values ?? {}),
			{ text: "Build", tone: "primary" },
			{ text: "working", tone: "success" }
		);
		expect(english.map((segment) => segment.text)).toEqual([
			"Build",
			" is now ",
			"working",
		]);
	});
});
