import { describe, expect, test } from "bun:test";
import { providerLoginEventText } from "./ProviderLoginDialog-event-text.ts";

const german: Record<string, string> = {
	"Sign in with AWS Builder ID. Enter code {code} if requested.":
		"Melde dich mit der AWS Builder ID an. Gib bei Bedarf den Code {code} ein.",
	"ChatGPT sign-in timed out. Start again.":
		"Die ChatGPT-Anmeldung hat zu lange gedauert. Starte sie erneut.",
};
const tl = (source: string, values: Record<string, string | number>) =>
	(german[source] ?? source).replace(/\{(\w+)\}/g, (_match, name: string) =>
		String(values[name] ?? "")
	);

describe("provider sign-in event text", () => {
	test("renders Core's message in the reader's language", () => {
		const event = {
			i18n: {
				args: { code: "ABCD-EFGH" },
				message: "Sign in with AWS Builder ID. Enter code {code} if requested.",
			},
			instructions:
				"Sign in with AWS Builder ID. Enter code ABCD-EFGH if requested.",
			type: "auth_url",
		};
		expect(providerLoginEventText(event, event.instructions, tl)).toBe(
			"Melde dich mit der AWS Builder ID an. Gib bei Bedarf den Code ABCD-EFGH ein."
		);
	});

	test("shows a bridge flow's text as sent and passes absence through", () => {
		const event = {
			instructions: "Paste the code from claude.ai",
			type: "auth_url",
		};
		expect(providerLoginEventText(event, event.instructions, tl)).toBe(
			"Paste the code from claude.ai"
		);
		expect(providerLoginEventText({ type: "info" }, undefined, tl)).toBeNull();
	});

	test("renders a coded sign-in failure in the reader's language", () => {
		const event = {
			code: "chatgpt_plan_timed_out",
			i18n: { args: {}, message: "ChatGPT sign-in timed out. Start again." },
			message: "ChatGPT sign-in timed out. Start again.",
			type: "error",
		};
		expect(providerLoginEventText(event, event.message, tl)).toBe(
			"Die ChatGPT-Anmeldung hat zu lange gedauert. Starte sie erneut."
		);
	});
});
