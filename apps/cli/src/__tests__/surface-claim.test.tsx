/* @jsxImportSource @opentui/react */
// End-to-end test of the seam that RETIRES a bespoke surface: with the contributions
// feed stubbed, a built-in screen (here /calendar) renders the plugin's declarative
// view instead of its hand-written body, and falls back to that body when no app
// claims it. This is the whole point of the `views` contribution — the shell stops
// re-implementing an app's UI — so it is pinned at the surface level, through the
// real provider stack and the real router, not just at the helper level.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { ContributionsProvider } from "../core/ContributionsContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import { ProductModeProvider } from "../core/ProductModeContext.tsx";
import { OverlayProvider } from "../overlays/OverlayHost.tsx";
import { TerminalThemeProvider } from "../ui/TerminalThemeProvider.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { ToastProvider } from "../ui/toast.tsx";
import { SplitView } from "../workspace/SplitView.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };

const CLAIMING_PAYLOAD = {
	views: [
		{
			id: "surface:calendar",
			plugin: "com.example.calendar",
			title: "Agenda",
			view: "list-detail",
			spec: {
				view: "list-detail",
				items: [
					{
						id: "standup",
						title: "Daily standup",
						subtitle: "weekdays at 09:00",
					},
				],
				itemActions: [{ id: "open", label: "Open", style: "primary" }],
			},
		},
	],
};

const realFetch = globalThis.fetch;
const fetchStringInputSchema = z.string({
	error: "Expected a primitive fetch string",
});
function isStringFetchInput(
	input: Parameters<typeof realFetch>[0]
): input is string {
	return fetchStringInputSchema.safeParse(input).success;
}
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let testHome: string | null = null;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
let ws: ReturnType<typeof useWorkspace> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	ws = null;
	if (testHome) {
		rmSync(testHome, { force: true, recursive: true });
		testHome = null;
	}
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
});

function isolateHome(): void {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-surface-claim-"));
	process.env.HOME = testHome;
	delete process.env.USERPROFILE;
}

/** Answer the contributions endpoint with `payload`; every other Core read (the
 *  built-in surfaces' own fetches) resolves empty so nothing hangs. */
function stubCore(payload: AppRequestValue): void {
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof realFetch>[0]) => {
			// SAFETY: The native fetch input is string, Request, or URL. The parsed string branch
			// excludes strings; this preserves the legacy optional opaque .url read on the
			// remaining object, including undefined for ordinary URL (not its .href). No Request
			// or business DTO is claimed; its raw inherited/getter value goes only to native String.
			const url = String(
				isStringFetchInput(input)
					? input
					: (
							input as Exclude<Parameters<typeof realFetch>[0], string> & {
								url?: unknown;
							}
						).url
			);
			const body = url.includes("/api/plugins/contributions") ? payload : {};
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			);
		},
		{ preconnect: realFetch.preconnect }
	);
}

function Capture() {
	ws = useWorkspace();
	return null;
}

function Harness() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<TerminalThemeProvider>
					<ContributionsProvider>
						<InputFocusProvider>
							<ToastProvider>
								<ChatIntentProvider>
									<WorkspaceProvider>
										<OverlayProvider>
											<ProductModeProvider>
												<Capture />
												<box flexDirection="column" height="100%" width="100%">
													<SplitView />
												</box>
											</ProductModeProvider>
										</OverlayProvider>
									</WorkspaceProvider>
								</ChatIntentProvider>
							</ToastProvider>
						</InputFocusProvider>
					</ContributionsProvider>
				</TerminalThemeProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

async function flush(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	for (let pass = 0; pass < 4; pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
	}
}

test("a claiming contribution replaces the built-in Calendar body", async () => {
	isolateHome();
	stubCore(CLAIMING_PAYLOAD);
	testSetup = await testRender(<Harness />, { width: 120, height: 30 });
	await flush(testSetup);

	await act(async () => {
		ws?.openTab("/calendar");
	});
	await flush(testSetup);

	const frame = testSetup.captureCharFrame();
	// The app's data, rendered by the terminal's own renderer…
	expect(frame).toContain("Daily standup");
	expect(frame).toContain("1 Open");
	// …in place of the hand-written agenda's hint line.
	expect(frame).not.toContain("Enter open Tasks");
	expect(frame).not.toContain("Error:");
});

test("a claim whose spec cannot draw leaves the built-in Calendar body up", async () => {
	isolateHome();
	// `spec` is opaque to Core, so a manifest can declare a known kind without the
	// collection it is made of. Handing the screen over anyway would replace a
	// working agenda with an "unsupported view" line — the regression the claim
	// gate exists to prevent — and, before the renderer validated, would take the
	// whole terminal down through the root error boundary.
	stubCore({
		views: [
			{
				id: "surface:calendar",
				plugin: "com.example.calendar",
				title: "Agenda",
				view: "list-detail",
				spec: { view: "list-detail" },
			},
		],
	});
	testSetup = await testRender(<Harness />, { width: 120, height: 30 });
	await flush(testSetup);

	await act(async () => {
		ws?.openTab("/calendar");
	});
	await flush(testSetup);

	const frame = testSetup.captureCharFrame();
	expect(frame).toContain("Enter open Tasks");
	expect(frame).not.toContain("Unsupported view kind");
	expect(frame).not.toContain("Error:");
});

test("with no claiming contribution the built-in Calendar body still renders", async () => {
	isolateHome();
	stubCore({ views: [] });
	testSetup = await testRender(<Harness />, { width: 120, height: 30 });
	await flush(testSetup);

	await act(async () => {
		ws?.openTab("/calendar");
	});
	await flush(testSetup);

	const frame = testSetup.captureCharFrame();
	expect(frame).toContain("Enter open Tasks");
	expect(frame).not.toContain("Daily standup");
});
