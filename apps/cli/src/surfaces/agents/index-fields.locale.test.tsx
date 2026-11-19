/* @jsxImportSource @opentui/react */
// The agent editor's field rows and pickers splice their label, toggle state,
// action and page range into template literals, which the JSX runtime never
// translates. Pin the CLI to a German stub catalog before any screen loads,
// the way LANG=de_DE.UTF-8 does, and check each piece reads in German.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createCliTranslator } from "../../i18n/translate.ts";

const german = createCliTranslator("de", {
	"delegate agents": "Agenten delegieren",
	"{name} · disabled": "{name} · deaktiviert",
	"{name} · enabled": "{name} · aktiviert",
	"Enter to choose": "Eingabe zum Auswählen",
	"Enter to edit": "Eingabe zum Bearbeiten",
	"not used on this node": "auf diesem Knoten nicht verwendet",
	Off: "Aus",
	On: "Ein",
	"Showing {start}–{end} of {total}": "{start}–{end} von {total}",
	tools: "Werkzeuge",
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
const { ThemeProvider, useTheme } = await import(
	"@/components/ui/theme-provider.tsx"
);
const { testRender } = await import("../../__tests__/cli-test-render.ts");
const { ryuTheme } = await import("../../ui/theme.ts");
const { AgentCapabilityPicker, PickerField, ToggleField } = await import(
	"./index-fields.tsx"
);
const { skillPickerRows } = await import("./capabilities.ts");

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

function Fields() {
	const theme = useTheme();
	return (
		<box flexDirection="column">
			<ToggleField
				focused={false}
				label="delegate agents"
				theme={theme}
				value="on"
			/>
			<PickerField focused={false} label="tools" theme={theme} value="2" />
		</box>
	);
}

function RemotePeerAccess() {
	const theme = useTheme();
	return (
		<PickerField
			action="Eingabe zum Bearbeiten"
			focused={false}
			label="tools"
			theme={theme}
			value="not used on this node"
		/>
	);
}

function Picker() {
	const theme = useTheme();
	const rows = Array.from({ length: 20 }, (_, index) => ({
		description: null,
		id: `tool-${index}`,
		label: `tool-${index}`,
		missing: false,
		tool: null,
	}));
	return (
		<AgentCapabilityPicker
			error={null}
			focusedIndex={0}
			kind="tools"
			notice=""
			rows={rows}
			selected={new Set()}
			status="ready"
			summary="all"
			theme={theme}
		/>
	);
}

async function frame(node: ReactNode, height: number): Promise<string> {
	setup = await testRender(
		<ThemeProvider reducedMotion theme={ryuTheme}>
			{node}
		</ThemeProvider>,
		{ width: 100, height }
	);
	await setup.renderOnce();
	return setup.captureCharFrame();
}

describe("agent editor fields under German", () => {
	test("a toggle row names its field and its on/off state in German", async () => {
		const text = await frame(<Fields />, 6);
		expect(text).toContain("Agenten delegieren");
		expect(text).toContain("● Ein   ○ Aus");
		expect(text).not.toContain("delegate agents");
	});

	test("a picker row names its field and its action in German", async () => {
		const text = await frame(<Fields />, 6);
		expect(text).toContain("Werkzeuge");
		expect(text).toContain("Eingabe zum Auswählen · 2");
	});

	test("a picker row's value is translated after its action", async () => {
		const text = await frame(<RemotePeerAccess />, 3);
		expect(text).toContain(
			"Eingabe zum Bearbeiten · auf diesem Knoten nicht verwendet"
		);
		expect(text).not.toContain("not used on this node");
	});

	test("the picker's page range is one German phrase", async () => {
		const text = await frame(<Picker />, 30);
		expect(text).toContain("1–11 von 20");
		expect(text).not.toContain(" of 20");
	});

	test("a skill row's state is part of its German sentence", () => {
		const rows = skillPickerRows(
			[],
			[
				{ description: null, enabled: true, id: "docs", name: "Docs" },
				{ description: null, enabled: false, id: "ship", name: "Ship" },
			]
		);
		expect(rows.map((row) => row.label)).toEqual([
			"Docs · aktiviert",
			"Ship · deaktiviert",
		]);
	});
});
