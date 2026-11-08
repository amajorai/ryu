/* @jsxImportSource @opentui/react */
// The tools/skills catalog pane says "Loading tools…" and "Couldn't load
// skills: …" as whole messages, one per kind, so a translator never sees an
// English plural spliced into a translated frame.

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider.tsx";
import { testRender } from "../../__tests__/cli-test-render.ts";
import { ryuTheme } from "../../ui/theme.ts";
import { AgentCapabilityPicker } from "./index-fields.tsx";
import type { CatalogStatus, PickerKind } from "./index-shared.tsx";

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

function Picker({
	error,
	kind,
	status,
}: {
	error: string | null;
	kind: PickerKind;
	status: CatalogStatus;
}) {
	const theme = useTheme();
	return (
		<AgentCapabilityPicker
			error={error}
			focusedIndex={0}
			kind={kind}
			notice=""
			rows={[]}
			selected={new Set()}
			status={status}
			summary="none"
			theme={theme}
		/>
	);
}

async function frameFor(
	kind: PickerKind,
	status: CatalogStatus,
	error: string | null
) {
	setup = await testRender(
		<ThemeProvider reducedMotion theme={ryuTheme}>
			<Picker error={error} kind={kind} status={status} />
		</ThemeProvider>,
		{ width: 100, height: 16 }
	);
	await setup.renderOnce();
	return setup.captureCharFrame();
}

test("each kind has its own whole loading line", async () => {
	expect(await frameFor("tools", "loading", null)).toContain("Loading tools…");
	await act(async () => {
		setup?.renderer.destroy();
	});
	setup = null;
	expect(await frameFor("skills", "loading", null)).toContain(
		"Loading skills…"
	);
});

test("each kind has its own whole load-failure message", async () => {
	expect(await frameFor("tools", "error", "offline")).toContain(
		"Couldn't load tools: offline. Press r to retry."
	);
	await act(async () => {
		setup?.renderer.destroy();
	});
	setup = null;
	expect(await frameFor("skills", "error", "offline")).toContain(
		"Couldn't load skills: offline. Press r to retry."
	);
});
