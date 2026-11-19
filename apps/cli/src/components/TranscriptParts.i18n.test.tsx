/* @jsxImportSource @opentui/react */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createCliTranslator } from "../i18n/translate.ts";

// The todo card headed the agent's plan with the bare word "Plan", which every
// catalog reads as a billing plan (de "Tarif"). Pin the CLI (JSX runtime, tf
// and tr) to a German stub catalog before any screen module loads, the way
// LANG=de_DE.UTF-8 does at startup; the shipped catalog has no "Agent plan"
// entry yet.
const german = createCliTranslator("de", {
	"Agent plan": "Agentenplan",
	"No tasks yet": "Noch keine Aufgaben",
	Plan: "Tarif",
	"{completed}/{total} complete": "{completed}/{total} erledigt",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { ThemeProvider } = await import(
	"../../components/ui/theme-provider.tsx"
);
const { TranscriptParts } = await import("./TranscriptParts.tsx");
const { testRender } = await import("../__tests__/cli-test-render.ts");

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;

afterEach(async () => {
	const current = setup;
	setup = null;
	if (current) {
		await act(async () => {
			current.renderer.destroy();
		});
	}
});

async function todoFrame(
	todos: { content: string; status: string }[]
): Promise<string> {
	setup = await testRender(
		<ThemeProvider reducedMotion>
			<TranscriptParts parts={[{ type: "todo", todos }]} />
		</ThemeProvider>,
		{ width: 60, height: 8 }
	);
	await setup.renderOnce();
	return setup.captureCharFrame();
}

describe("TodoPart under a German translator", () => {
	test("heads the card as the agent plan, not a billing plan", async () => {
		const frame = await todoFrame([
			{ content: "Write the migration", status: "completed" },
			{ content: "Run the tests", status: "pending" },
		]);
		expect(frame).toContain("Agentenplan");
		expect(frame).toContain("1/2 erledigt");
		expect(frame).not.toContain("Tarif");
	});

	test("translates the empty card", async () => {
		const frame = await todoFrame([]);
		expect(frame).toContain("Agentenplan");
		expect(frame).toContain("Noch keine Aufgaben");
	});
});
