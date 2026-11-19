/* @jsxImportSource @opentui/react */
// The split-out Settings panels: General shows the node, auth state and the
// startup realm choices; the info panels render their badge, description and
// note, and a data panel lists its loader's rows.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { testRender } from "../../__tests__/cli-test-render.ts";
import { CoreProvider } from "../../core/CoreContext.tsx";
import { InputFocusProvider } from "../../core/InputFocusContext.tsx";
import { ProductModeProvider } from "../../core/ProductModeContext.tsx";
import { ryuTheme } from "../../ui/theme.ts";
import { ToastProvider } from "../../ui/toast.tsx";
import { WorkspaceProvider } from "../../workspace/WorkspaceContext.tsx";
import { OverlayProvider } from "../OverlayHost.tsx";
import { GeneralPanel } from "./general-panel.tsx";
import {
	DATA_PANELS,
	DataPanel,
	PANEL_META,
	PlaceholderPanel,
} from "./info-panels.tsx";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
let configDir: string | null = null;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	if (configDir) {
		rmSync(configDir, { force: true, recursive: true });
		configDir = null;
	}
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
});

/** Every Core read resolves empty so nothing hangs or reaches the network. */
function stubCore(): void {
	globalThis.fetch = Object.assign(
		() =>
			Promise.resolve(
				new Response("{}", {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			),
		{ preconnect: realFetch.preconnect }
	);
}

function Providers({ children }: { children: ReactNode }) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<InputFocusProvider>
					<ToastProvider>
						<WorkspaceProvider>
							<OverlayProvider>{children}</OverlayProvider>
						</WorkspaceProvider>
					</ToastProvider>
				</InputFocusProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

async function frameOf(node: ReactNode): Promise<string> {
	setup = await testRender(<Providers>{node}</Providers>, {
		height: 30,
		width: 100,
	});
	for (let pass = 0; pass < 4; pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup?.renderOnce();
		});
	}
	return setup.captureCharFrame();
}

test("General shows the node, its auth state and the startup realm choices", async () => {
	configDir = mkdtempSync(join(tmpdir(), "ryu-cli-settings-panels-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	stubCore();
	const frame = await frameOf(
		<ProductModeProvider>
			<GeneralPanel />
		</ProductModeProvider>
	);
	expect(frame).toContain("127.0.0.1:7980");
	expect(frame).toContain("no token");
	expect(frame).toContain("Startup realm");
	expect(frame).toContain("Last used");
});

test("a desktop-only handoff shows its badge, description and note", async () => {
	const meta = PANEL_META.get("shadow");
	expect(meta?.tone).toBe("desktop");
	const frame = await frameOf(
		<PlaceholderPanel meta={meta ?? { description: "" }} title="Shadow" />
	);
	expect(frame).toContain("Desktop only");
	expect(frame).toContain("Shadow screen capture runs as a native agent.");
	expect(frame).toContain("Open the desktop app to configure Shadow.");
});

test("a data panel lists its loader's rows under the danger badge", async () => {
	const danger = DATA_PANELS.get("danger");
	expect(danger).toBeDefined();
	if (!danger) {
		return;
	}
	const meta = {
		...danger,
		load: () => Promise.resolve([{ id: "chats", title: "Chats 12" }]),
	};
	const frame = await frameOf(
		<DataPanel height={10} meta={meta} title="Danger Zone" />
	);
	expect(frame).toContain("Danger zone");
	expect(frame).toContain("Deletable data on this node, by category.");
	expect(frame).toContain("Chats 12");
});
