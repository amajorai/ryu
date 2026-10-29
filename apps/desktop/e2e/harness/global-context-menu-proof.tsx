import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { ThemeProvider, useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { GlobalContextMenu } from "../../src/components/shell/GlobalContextMenu.tsx";
import { initTheme } from "../../src/hooks/useThemePreset.ts";
import { installConsoleCapture } from "../../src/lib/console-buffer.ts";
import { setCrashRoute } from "../../src/lib/crash-context.ts";
import {
	getFullscreen,
	subscribeFullscreen,
} from "../../src/lib/fullscreen.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

type ProofWindow = Window & {
	__RYU_GLOBAL_CONTEXT_MENU_PROOF__?: { pageLoads: number };
};

installConsoleCapture();
initTheme();
setCrashRoute({
	path: "/proof/global-context-menu",
	title: "Global Context Menu Proof",
});

function ThemeState() {
	const { resolvedTheme, theme } = useTheme();
	return (
		<output
			data-resolved-theme={resolvedTheme ?? "unset"}
			data-testid="theme-state"
			data-theme={theme ?? "unset"}
		>
			{theme ?? "unset"} · {resolvedTheme ?? "unset"}
		</output>
	);
}

function SettingsState() {
	const open = useSettingsDialog((state) => state.open);
	const section = useSettingsDialog((state) => state.section);
	return (
		<output
			data-open={String(open)}
			data-section={section}
			data-testid="settings-state"
		>
			{open ? `Settings: ${section}` : "Settings closed"}
		</output>
	);
}

function FullscreenState() {
	const fullscreen = useSyncExternalStore(
		subscribeFullscreen,
		getFullscreen,
		() => false
	);
	return (
		<output data-fullscreen={String(fullscreen)} data-testid="fullscreen-state">
			{fullscreen ? "Full Screen" : "Windowed"}
		</output>
	);
}

function ProofSurface() {
	const pageLoads =
		/* SAFETY: The owning spec addInitScript publishes the pageLoads number before navigation; this view reads only that private field with the existing absent-value fallback. */ (
			window as ProofWindow
		).__RYU_GLOBAL_CONTEXT_MENU_PROOF__?.pageLoads ?? 0;
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<GlobalContextMenu>
				<main
					className="min-h-screen bg-background p-8 text-foreground"
					data-testid="menu-target"
				>
					<header className="mb-8 border-border border-b pb-5">
						<p className="text-muted-foreground text-xs uppercase tracking-widest">
							Rendered desktop component proof
						</p>
						<h1 className="mt-2 font-semibold text-2xl">Global Context Menu</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Right-click this surface or the editing field to exercise the
							production context menu. Clipboard, fullscreen, native commands,
							and feedback opening stay inside this local browser fixture.
						</p>
					</header>
					<div className="grid max-w-4xl gap-4 md:grid-cols-2">
						<section className="rounded-xl border border-border bg-card p-5">
							<h2 className="font-medium">Selection source</h2>
							<p
								className="mt-2 select-text text-sm"
								data-testid="plain-copy-source"
							>
								Select this proof sentence to copy page text from the browser.
							</p>
						</section>
						<section className="rounded-xl border border-border bg-card p-5">
							<h2 className="font-medium">Editable source</h2>
							<label className="mt-3 block text-sm" htmlFor="proof-editor">
								Text to edit
							</label>
							<input
								className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2"
								data-testid="editor"
								defaultValue="alpha beta gamma"
								id="proof-editor"
							/>
						</section>
						<section className="rounded-xl border border-border bg-card p-5">
							<h2 className="font-medium">Observed persisted state</h2>
							<div className="mt-3 grid gap-2 font-mono text-xs">
								<ThemeState />
								<SettingsState />
								<FullscreenState />
								<output data-testid="page-loads">Page load {pageLoads}</output>
								<output data-testid="zoom-state">
									Zoom {document.documentElement.style.zoom || "default"}
								</output>
							</div>
						</section>
						<section className="rounded-xl border border-border bg-card p-5">
							<h2 className="font-medium">Local fixture boundary</h2>
							<p className="mt-2 text-muted-foreground text-sm">
								No system clipboard, native window, or external feedback service
								is used by this proof.
							</p>
						</section>
					</div>
				</main>
			</GlobalContextMenu>
			<Toaster position="bottom-right" theme="system" />
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Global context menu proof root is missing");
}

createRoot(root).render(<ProofSurface />);
