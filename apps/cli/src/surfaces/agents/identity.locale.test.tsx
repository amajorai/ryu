/* @jsxImportSource @opentui/react */
// The identity cards and the account-access panel splice the mode title and an
// account kind into template literals, which the JSX runtime never translates.
// Pin the CLI to a German stub catalog before any screen loads and check each
// name reads in German.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"Acts as you": "Handelt als Sie",
	Allowed: "Erlaubt",
	"Connected apps": "Verbundene Apps",
	"Couldn't load your model providers.":
		"Ihre Modellanbieter konnten nicht geladen werden.",
	"Model providers": "Modellanbieter",
	"No connected apps yet.": "Noch keine verbundenen Apps.",
	"{title}: {notice}": "{title} – {notice}",
	"Its own identity": "Eigene Identität",
	"No limit": "Keine Begrenzung",
	Other: "Sonstiges",
	"Sign in again": "Erneut anmelden",
	"Subscriptions you signed in to through Ryu, if any":
		"Abonnements, bei denen Sie sich über Ryu angemeldet haben, falls vorhanden",
});
mock.module("../../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { ThemeProvider } = await import("@/components/ui/theme-provider.tsx");
const { testRender } = await import("../../__tests__/cli-test-render.ts");
const { ryuTheme } = await import("../../ui/theme.ts");
const { AgentAccountAccessPanel, AgentIdentityStep, accessPanelLines } =
	await import("./identity.tsx");

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	const current = setup;
	setup = null;
	if (current) {
		await act(async () => {
			current.renderer.destroy();
		});
	}
});

async function frame(node: ReactNode): Promise<string> {
	setup = await testRender(
		<ThemeProvider reducedMotion theme={ryuTheme}>
			{node}
		</ThemeProvider>,
		{ width: 120, height: 30 }
	);
	await setup.renderOnce();
	return setup.captureCharFrame();
}

describe("agent identity screens under German", () => {
	test("each identity card titles its mode in German", async () => {
		const text = await frame(<AgentIdentityStep selected="managed" title="" />);
		expect(text).toContain("● Handelt als Sie");
		expect(text).toContain("○ Eigene Identität");
		expect(text).not.toContain("Acts as you");
	});

	test("the access panel names the mode and a kept key's kind in German", async () => {
		const text = await frame(
			<AgentAccountAccessPanel
				accountAccess={null}
				accounts={null}
				addError={null}
				adding={false}
				addText=""
				focusedIndex={0}
				identityMode="managed"
				locked={false}
				onAddInput={() => undefined}
				rows={[
					{
						detail: null,
						key: "composio:ca_1",
						section: "not-listed",
						status: null,
						title: "composio:ca_1",
					},
				]}
			/>
		);
		expect(text).toContain("Keine Begrenzung · Handelt als Sie");
		expect(text).toContain("composio:ca_1 · Verbundene Apps");
		expect(text).not.toContain("Connected apps");
	});

	test("an empty or failed section's note is translated whole", () => {
		const notes = accessPanelLines(
			{
				hiddenGroups: [],
				sections: [
					{
						empty: "No connected apps yet.",
						error: null,
						id: "connected-apps",
						owner: "yours",
						rows: [],
						title: "Connected apps",
					},
					{
						empty: "No provider keys yet.",
						error: "Couldn't load your model providers.",
						id: "model-providers",
						owner: "yours",
						rows: [],
						title: "Model providers",
					},
				],
			},
			[]
		).flatMap((line) => (line.kind === "note" ? [line.text] : []));
		expect(notes).toEqual([
			"Verbundene Apps – Noch keine verbundenen Apps.",
			"Modellanbieter – Ihre Modellanbieter konnten nicht geladen werden.",
		]);
	});

	test("the kept-accounts heading reads in German while accounts load", () => {
		const headings = accessPanelLines(null, [
			{
				detail: null,
				key: "provider:gone",
				section: "not-listed",
				status: null,
				title: "Gone",
			},
		]).flatMap((line) => (line.kind === "heading" ? [line.text] : []));
		expect(headings).toEqual(["Erlaubt"]);
	});

	test("an account row's title and status read in German", async () => {
		const rows = [
			{
				detail: null,
				key: "provider:core",
				section: "model-providers" as const,
				status: "Sign in again",
				title: "Subscriptions you signed in to through Ryu, if any",
			},
		];
		const text = await frame(
			<AgentAccountAccessPanel
				accountAccess={null}
				accounts={{
					hiddenGroups: [],
					sections: [
						{
							empty: "No provider keys yet.",
							error: null,
							id: "model-providers",
							owner: "yours",
							rows,
							title: "Model providers",
						},
					],
				}}
				addError={null}
				adding={false}
				addText=""
				focusedIndex={0}
				identityMode="managed"
				locked={false}
				onAddInput={() => undefined}
				rows={rows}
			/>
		);
		expect(text).toContain("Abonnements, bei denen Sie sich über Ryu");
		expect(text).toContain("(Erneut anmelden)");
		expect(text).not.toContain("Sign in again");
	});
});
