/* @jsxImportSource @opentui/react */
// Shared harness for the Store interaction suites (store.interactions and
// store.plugins-lifecycle.interactions): the mounted Store pane with its
// providers, a fetch stub, and key, wait and active-section helpers.

import { afterEach } from "bun:test";
import { KeyEvent, TextAttributes } from "@opentui/core";
import type { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import type { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { ContributionsProvider } from "../core/ContributionsContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import {
	InputFocusProvider,
	useInputFocused,
} from "../core/InputFocusContext.tsx";
import { OverlayProvider } from "../overlays/OverlayHost.tsx";
import { STORE_SECTIONS } from "../surfaces/store/sections.ts";
import { ryuTheme } from "../ui/theme.ts";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { resolveSurface } from "../workspace/router.ts";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

export interface StoreActionObservation {
	body: z.infer<typeof appResponseValueSchema>;
	path: string;
}

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
let testSetup: Setup | null = null;
let storeInputFocused = false;

export function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}

/** Whether the Store's search input currently holds keyboard focus. */
export function isStoreInputFocused(): boolean {
	return storeInputFocused;
}

function CaptureFocus() {
	storeInputFocused = useInputFocused();
	return null;
}

function StorePane() {
	const { focusedPaneId } = useWorkspace();
	const surface = resolveSurface("/store");
	if (!surface) {
		return null;
	}
	const Store = surface.Component;
	return <Store active={true} paneId={focusedPaneId} />;
}

function Harness() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<ContributionsProvider>
					<InputFocusProvider>
						<ToastProvider>
							<ChatIntentProvider>
								<WorkspaceProvider>
									<OverlayProvider>
										<CaptureFocus />
										<StorePane />
										<ToastHost />
									</OverlayProvider>
								</WorkspaceProvider>
							</ChatIntentProvider>
						</ToastProvider>
					</InputFocusProvider>
				</ContributionsProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

/** Restore fetch and unmount the Store after each test of the calling suite. */
export function registerStoreHarnessHooks(): void {
	afterEach(async () => {
		globalThis.fetch = realFetch;
		await act(async () => {
			testSetup?.renderer.destroy();
			await Promise.resolve();
		});
		testSetup = null;
		storeInputFocused = false;
	});
}

export async function press(
	setup: Setup,
	name: string,
	ctrl = false,
	shift = false
): Promise<void> {
	if (name === "right" || name === "left") {
		await act(async () => {
			setup.mockInput.pressArrow(name);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await setup.flush({ maxPasses: 12 });
		return;
	}
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl,
				shift,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await setup.renderOnce();
}

/** Mount the Store pane at a size without waiting for its first load. */
export async function mountStore(
	width: number,
	height: number
): Promise<Setup> {
	testSetup = await testRender(<Harness />, { width, height });
	return testSetup;
}

export async function renderStore(width = 120): Promise<void> {
	const setup = await mountStore(width, 36);
	await waitFor(setup, (frame) => frame.includes("refresh"));
}

export function currentSetup(): Setup {
	if (!testSetup) {
		throw new Error("Store renderer is not mounted");
	}
	return testSetup;
}

export async function waitFor(
	setup: Setup,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Store render did not match: ${frame}`);
	}
	return frame;
}

export function activeSection(setup: Setup): string | undefined {
	const labels = new Set(STORE_SECTIONS.map((section) => section.label));
	for (const line of setup.captureSpans().lines) {
		for (const span of line.spans) {
			const label = span.text.trim();
			if (labels.has(label) && (span.attributes & TextAttributes.BOLD) !== 0) {
				return label;
			}
		}
	}
	return undefined;
}
