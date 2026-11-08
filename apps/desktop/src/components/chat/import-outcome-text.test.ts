import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import { type ImportOutcome, runImport } from "@/src/lib/api/import.ts";
import type { NoticeTranslate } from "@/src/lib/cloud-task-notice-text.ts";
import { importOutcomeLine } from "./import-outcome-text.ts";

const LINE = "{title}: {detail}";
const AGENT = "Agent definition '{name}'";
const UNREADABLE = "The file is not a readable agent definition.";
const UNSAFE = "The URL “{url}” is not safe to connect to: {error}";

const german: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[LINE]: "{title}: {detail}",
		[AGENT]: "Agent-Definition '{name}'",
		[UNREADABLE]: "Die Datei ist keine lesbare Agent-Definition.",
		[UNSAFE]: "Die URL „{url}“ ist nicht sicher erreichbar: {error}",
	};
	return formatMessage(catalog[source] ?? source, values, "de");
};

const japanese: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[LINE]: "{title}：{detail}",
		[UNREADABLE]: "このファイルは読み取れるエージェント定義ではありません。",
	};
	return formatMessage(catalog[source] ?? source, values, "ja");
};

const arabic: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[LINE]: "{title}: {detail}",
		[AGENT]: "تعريف الوكيل '{name}'",
		[UNSAFE]: "عنوان URL “{url}” غير آمن للاتصال: {error}",
	};
	return formatMessage(catalog[source] ?? source, values, "ar");
};

const failed: ImportOutcome = {
	alreadyExists: false,
	detail: UNREADABLE,
	detailI18n: [{ message: UNREADABLE, args: {} }],
	id: "agents/reviewer.md",
	kind: "agent",
	status: "failed",
	title: "Agent definition 'reviewer'",
	titleI18n: { message: AGENT, args: { name: "reviewer" } },
};

test("renders a failed outcome's title and reason in German", () => {
	expect(importOutcomeLine(failed, german)).toBe(
		"Agent-Definition 'reviewer': Die Datei ist keine lesbare Agent-Definition."
	);
});

test("renders reason arguments and the locale's separator", () => {
	expect(
		importOutcomeLine(
			{
				...failed,
				detail: "The URL “http://10.0.0.1” is not safe to connect to: denied",
				detailI18n: [
					{
						message: UNSAFE,
						args: { error: "denied", url: "http://10.0.0.1" },
					},
				],
			},
			german
		)
	).toBe(
		"Agent-Definition 'reviewer': Die URL „http://10.0.0.1“ ist nicht sicher erreichbar: denied"
	);
	expect(
		importOutcomeLine(
			{ ...failed, title: "agents/reviewer.md", titleI18n: undefined },
			japanese
		)
	).toBe(
		"agents/reviewer.md：このファイルは読み取れるエージェント定義ではありません。"
	);
});

test("falls back to Core's English when the outcome carries no message", () => {
	const older: ImportOutcome = {
		alreadyExists: false,
		detail: "permission denied (os error 13)",
		id: "plugins/p",
		kind: "plugin",
		status: "failed",
		title: "plugins/p",
	};
	expect(importOutcomeLine(older, german)).toBe(
		"plugins/p: permission denied (os error 13)"
	);
});

test("a failed outcome from Core's wire renders in Arabic after runImport", async () => {
	// The JSON shape `ImportOutcome::failed_msg(..).titled(..)` serializes
	// (apps/core/src/import/outcome_text.rs).
	const wire = {
		id: "mcp/docs",
		kind: "mcp_server",
		status: "failed",
		title: "Agent definition 'reviewer'",
		title_i18n: { message: AGENT, args: { name: "reviewer" } },
		detail: "The URL “http://10.0.0.1” is not safe to connect to: denied",
		detail_i18n: [
			{ message: UNSAFE, args: { url: "http://10.0.0.1", error: "denied" } },
		],
	};
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ root: "/fixtures", results: [wire] }),
	});
	try {
		const result = await runImport(
			{ token: "fixture", url: server.url.origin },
			"/fixtures",
			[{ id: "mcp/docs", kind: "mcp_server" }]
		);
		const [outcome] = result.results;
		expect(outcome).toBeDefined();
		if (outcome === undefined) {
			return;
		}
		expect(importOutcomeLine(outcome, arabic)).toBe(
			// Latin values are bidi-isolated (FSI … PDI) inside the RTL line.
			"تعريف الوكيل '\u2068reviewer\u2069': عنوان URL “http://10.0.0.1” غير آمن للاتصال: \u2068denied\u2069"
		);
	} finally {
		server.stop(true);
	}
});
