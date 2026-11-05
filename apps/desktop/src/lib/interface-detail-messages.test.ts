import { afterEach, describe, expect, test } from "bun:test";
import { messageIdForLiteral } from "@ryu/i18n/lite";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import { activityLabel, toolActivityLabel } from "./interface-detail.ts";
import {
	activityMessage,
	toolRepeatsKindVerb,
} from "./interface-detail-messages.ts";
import { LABEL_MAX } from "./interface-detail-parts.ts";

/** German whole sentences, keyed by catalog id, for the stand-in runtime. */
const GERMAN: Record<string, string> = {
	[messageIdForLiteral("Asking {target}")]: "Fragt {target}",
	[messageIdForLiteral("Asking a question")]: "Stellt eine Frage",
	[messageIdForLiteral("Thinking")]: "Denkt nach",
	[messageIdForLiteral("Editing {target}")]: "Bearbeitet {target}",
	[messageIdForLiteral("Using {target}")]: "Verwendet {target}",
};

const german: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "de",
	translate: (id, values, fallback) => {
		const template = GERMAN[id] ?? fallback ?? id;
		const target = (values as Record<string, unknown> | undefined)?.target;
		return template.replace("{target}", String(target ?? ""));
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("activityMessage", () => {
	test("reads whole English sentences without a provider", () => {
		expect(activityMessage("ask", "Lena")).toBe("Asking Lena");
		expect(activityMessage("ask", null)).toBe("Asking a question");
		expect(activityMessage("answer")).toBe("Writing the answer");
		expect(activityMessage("think", "  ")).toBe("Thinking");
		expect(activityMessage("tool", null)).toBe("Using a tool");
	});

	test("translates ask with a target as one German sentence", () => {
		registerActiveI18nRuntime(german);
		const label = activityMessage("ask", "Lena");
		expect(label).toBe("Fragt Lena");
		expect(label).not.toContain("Angebot wird bei");
	});

	test("a kind with no target uses its standalone form", () => {
		registerActiveI18nRuntime(german);
		expect(activityMessage("think")).toBe("Denkt nach");
		expect(activityMessage("ask")).toBe("Stellt eine Frage");
	});
});

describe("activity labels", () => {
	test("clamping keeps the translated text", () => {
		registerActiveI18nRuntime(german);
		const label = activityLabel("edit", null, "x".repeat(80));
		expect(label.startsWith("Bearbeitet ")).toBe(true);
		expect(label.length).toBe(LABEL_MAX);
		expect(label.endsWith("…")).toBe(true);
	});

	test("a tool step names the tool through the whole message", () => {
		registerActiveI18nRuntime(german);
		expect(activityLabel("tool", "github__create_pull_request", null)).toBe(
			"Verwendet create pull request"
		);
		expect(
			toolActivityLabel({ input: {}, type: "tool-Mystery" }, "tool", "Mystery")
		).toBe("Verwendet Mystery");
	});

	test("the translation owns word order, not the English verb-first frame", () => {
		const japanese: ActiveI18nRuntime = {
			direction: "ltr",
			locale: "ja",
			translate: (id, values, fallback) =>
				(id === messageIdForLiteral("Editing {target}")
					? "{target} を編集中"
					: (fallback ?? id)
				).replace(
					"{target}",
					String((values as Record<string, unknown> | undefined)?.target)
				),
		};
		registerActiveI18nRuntime(japanese);
		try {
			expect(activityLabel("edit", null, "snapshot.ts")).toBe(
				"snapshot.ts を編集中"
			);
		} finally {
			unregisterActiveI18nRuntime(japanese);
		}
	});

	test("a tool named after its verb reads the standalone form", () => {
		expect(toolRepeatsKindVerb("edit", "Edit")).toBe(true);
		expect(toolRepeatsKindVerb("run", "Bash")).toBe(false);
		expect(toolRepeatsKindVerb("edit", "")).toBe(false);
	});
});
