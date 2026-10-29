/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { UpdatesPanel } from "../overlays/settings/updates.tsx";
import { renderTerminalSvg } from "../proof/render-terminal-svg.ts";
import { ryuTheme } from "../ui/theme.ts";

const preferenceWriteFields = z.looseObject({ value: z.string() });
const preferenceWriteObservation = z.custom<
	z.infer<typeof preferenceWriteFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		preferenceWriteFields.safeParse(value).success
);
function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof createTestRenderer>>;
let testSetup: Setup | null = null;
interface ReactActEnvironment {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
}
const actEnvironment: typeof globalThis & ReactActEnvironment = globalThis;
let previousActEnvironment: boolean | undefined;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

interface KeyInput {
	ctrl?: boolean;
	name: string;
}

async function press(setup: Setup, key: KeyInput): Promise<void> {
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	maxFrames = 100
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < maxFrames && !predicate(frame); pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Update settings did not render: ${frame}`);
	}
	return frame;
}

test("Updates toggles the shared Core auto-updates preference with readback", async () => {
	previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	let stored = JSON.stringify({ enabled: true });
	const writes: string[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/preferences/terminal-theme") {
			return Response.json({ value: { mode: "system", preset: "ryu" } });
		}
		if (url.pathname === "/api/update/check") {
			return Response.json({
				current: "0.4.0",
				latest: "0.4.0",
				update_available: false,
			});
		}
		if (url.pathname === "/api/preferences/auto-updates") {
			if (init?.method === "PUT") {
				const body = preferenceWriteObservation.parse(
					JSON.parse(String(init.body))
				);
				stored = body.value;
				writes.push(stored);
			}
			return Response.json({ key: "auto-updates", value: stored });
		}
		return Response.json({});
	});

	const setup = await createTestRenderer({ width: 110, height: 18 });
	testSetup = setup;
	await act(async () => {
		createRoot(setup.renderer).render(
			<CoreProvider initial={LOCAL_TARGET}>
				<ThemeProvider theme={ryuTheme}>
					<box
						backgroundColor={ryuTheme.colors.background}
						flexDirection="column"
						padding={2}
					>
						<text fg={ryuTheme.colors.primary}>
							<b>Ryu CLI · Settings</b>
						</text>
						<box marginTop={1}>
							<UpdatesPanel />
						</box>
					</box>
				</ThemeProvider>
			</CoreProvider>
		);
		await setup.renderOnce();
	});
	await waitForFrame(setup, (visible) =>
		visible.includes("Automatic updates: ON")
	);

	await press(setup, { name: "return" });
	await waitForFrame(setup, (visible) =>
		visible.includes("Automatic updates: OFF")
	);
	expect(writes).toEqual(['{"enabled":false}']);
	await waitForFrame(setup, (visible) =>
		visible.includes("Saved and confirmed from Core.")
	);

	await press(setup, { name: "return" });
	await waitForFrame(setup, (visible) =>
		visible.includes("Automatic updates: ON")
	);
	expect(writes).toEqual(['{"enabled":false}', '{"enabled":true}']);
	const proofPath = join(
		import.meta.dir,
		"../../../../docs/proof/auto-update-20261001/cli-settings-completed.svg"
	);
	mkdirSync(dirname(proofPath), { recursive: true });
	writeFileSync(proofPath, renderTerminalSvg(setup.captureSpans()));
});
