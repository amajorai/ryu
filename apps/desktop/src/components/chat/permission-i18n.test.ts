import { describe, expect, it } from "bun:test";
import { readPermissionI18n } from "./permission-i18n.ts";

const DE: Record<string, string> = {
	"Switch your interface to {interface}":
		"Wechsle deine Oberfläche zu {interface}",
	"Allow for this chat": "Für diesen Chat erlauben",
};

function tl(source: string, values?: Record<string, string | number>): string {
	const template = DE[source] ?? source;
	return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
		values && name in values ? String(values[name]) : match
	);
}

describe("readPermissionI18n", () => {
	it("renders Core's whole-sentence title, option labels and detail", () => {
		const i18n = readPermissionI18n(
			{
				title: "switch your interface to minimal",
				i18n: {
					title: {
						message: "Switch your interface to {interface}",
						args: { interface: "minimal" },
					},
					options: {
						allow_session: { message: "Allow for this chat", args: {} },
						reject_once: { message: 42 },
					},
					detail: " PUT /api/preferences/{key} ",
				},
			},
			tl
		);
		expect(i18n?.title).toBe("Wechsle deine Oberfläche zu minimal");
		expect(i18n?.optionLabels.get("allow_session")).toBe(
			"Für diesen Chat erlauben"
		);
		// A malformed label falls back to the option's own name.
		expect(i18n?.optionLabels.has("reject_once")).toBe(false);
		expect(i18n?.detail).toBe("PUT /api/preferences/{key}");
	});

	it("ignores prompts without a valid Core message", () => {
		expect(readPermissionI18n({ title: "run tests" }, tl)).toBeNull();
		expect(readPermissionI18n(null, tl)).toBeNull();
		expect(
			readPermissionI18n({ i18n: { title: { message: "" } } }, tl)
		).toBeNull();
		expect(
			readPermissionI18n(
				{ i18n: { title: { message: "Run {tool}", args: { tool: {} } } } },
				tl
			)
		).toBeNull();
	});
});
