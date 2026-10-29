import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import type { ComponentType } from "react";
import type { Root } from "react-dom/client";

// The REAL `DeferredSettingsDialog` that both `LazySettingsDialog` and
// `LazyGatewayDialog` wrap their code-split dialog in, mounted inside the real
// I18nProvider. The host below has the exact shape of those two callers: it owns
// `open`, passes `onOpenChange` through, and gives the wrapper a `React.lazy`
// child whose chunk resolves only when the test says so, so the loading
// fallback, the deferral and the retained state are all observable.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, lazy, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } =
	await import("@ryu/ui/components/dialog.tsx");
const { DeferredSettingsDialog } = await import("./DeferredSettingsDialog.tsx");
const {
	button,
	dialogDescription,
	dialogName,
	flush,
	installAnimationApis,
	openDialogs,
	press,
	text,
	until,
} = await import("./unswept-a.test-support.ts");
installAnimationApis();

interface ContentProps {
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

let loads = 0;
let mounts = 0;
let unmounts = 0;
let resolveChunk: (() => void) | null = null;
let Content: ComponentType<ContentProps>;

/** The code-split dialog body: a real Dialog holding local, unsaved state. */
function LoadedSettings({ onOpenChange, open }: ContentProps) {
	const [query, setQuery] = useState("");
	useEffect(() => {
		mounts += 1;
		return () => {
			unmounts += 1;
		};
	}, []);
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Loaded settings</DialogTitle>
					<DialogDescription>Every settings section.</DialogDescription>
				</DialogHeader>
				<input
					aria-label="Search settings"
					onChange={(event) => setQuery(event.target.value)}
					value={query}
				/>
			</DialogContent>
		</Dialog>
	);
}

function freshChunk(): ComponentType<ContentProps> {
	return lazy(() => {
		loads += 1;
		return new Promise<{ default: ComponentType<ContentProps> }>((resolve) => {
			resolveChunk = () => resolve({ default: LoadedSettings });
		});
	});
}

/** Mirrors `LazySettingsDialog`: owns `open`, forwards it to both layers. */
function Host() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button onClick={() => setOpen(true)} type="button">
				Open settings
			</button>
			<output data-host-open>{String(open)}</output>
			<DeferredSettingsDialog
				onOpenChange={setOpen}
				open={open}
				title="Settings"
			>
				<Content onOpenChange={setOpen} open={open} />
			</DeferredSettingsDialog>
		</>
	);
}

const FRENCH: LanguagePack = {
	baseLocale: "fr",
	direction: "ltr",
	id: "unswept-a.fr",
	locale: "fr-FR",
	messages: {
		"settings.loading": "Ouverture des réglages",
		"settings.title": "Réglages",
	},
	name: "Français (fixture)",
	schemaVersion: 1,
	version: "1.0.0",
};

let root: Root | null = null;

async function mount(pack: LanguagePack | null = null): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<I18nProvider
				initialLocale={pack ? pack.locale : "en-US"}
				initialPackId={pack?.id ?? null}
				packs={pack ? [pack] : []}
			>
				<Host />
			</I18nProvider>
		)
	);
	await flush(2);
}

function hostOpen(): string {
	return document.querySelector("[data-host-open]")?.textContent ?? "";
}

function skeletonCount(dialog: HTMLElement): number {
	return dialog.querySelectorAll('[data-slot="skeleton"]').length;
}

beforeEach(() => {
	loads = 0;
	mounts = 0;
	unmounts = 0;
	resolveChunk = null;
	Content = freshChunk();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
});

test("a never-opened settings dialog renders nothing and never starts loading its chunk", async () => {
	await mount();
	await act(async () => {
		await Bun.sleep(50);
	});
	expect(loads).toBe(0);
	expect(openDialogs()).toHaveLength(0);
	expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
	expect(text()).not.toContain("Opening settings");
	expect(hostOpen()).toBe("false");
});

test("first open shows an accessible loading dialog that Escape closes through onOpenChange, then the loaded dialog replaces it", async () => {
	await mount();
	await act(async () => button("Open settings").click());
	await until(() => openDialogs().length === 1, "loading dialog");
	expect(loads).toBe(1);
	const loading = openDialogs()[0] as HTMLElement;
	expect(dialogName(loading)).toBe("Settings");
	expect(dialogDescription(loading)).toBe("Opening settings");
	expect(skeletonCount(loading)).toBeGreaterThan(0);
	expect(text()).not.toContain("Loaded settings");

	// The loading shell is a real dialog: Escape asks the owner to close it.
	await press("Escape", loading);
	await until(() => openDialogs().length === 0, "loading dialog closed");
	expect(hostOpen()).toBe("false");

	// Reopening before the chunk lands shows the loading shell again, without
	// requesting the chunk a second time.
	await act(async () => button("Open settings").click());
	await until(() => openDialogs().length === 1, "loading dialog again");
	expect(dialogDescription(openDialogs()[0] as HTMLElement)).toBe(
		"Opening settings"
	);
	expect(loads).toBe(1);

	await act(async () => resolveChunk?.());
	await until(() => text().includes("Loaded settings"), "loaded dialog");
	const [loaded, ...others] = openDialogs();
	expect(others).toHaveLength(0);
	expect(dialogName(loaded as HTMLElement)).toBe("Loaded settings");
	expect(skeletonCount(loaded as HTMLElement)).toBe(0);
	expect(text()).not.toContain("Opening settings");
	expect(mounts).toBe(1);
});

test("after the first open the loaded dialog keeps its unsaved state across close and reopen and is never reloaded", async () => {
	await mount();
	await act(async () => button("Open settings").click());
	await act(async () => resolveChunk?.());
	await until(() => text().includes("Loaded settings"), "loaded dialog");
	const search = () =>
		document.querySelector<HTMLInputElement>(
			'input[aria-label="Search settings"]'
		);
	await act(async () => {
		const input = search();
		if (!input) {
			throw new Error("search input missing");
		}
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, "privacy");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(search()?.value).toBe("privacy");

	await press("Escape", openDialogs()[0] as HTMLElement);
	await until(() => openDialogs().length === 0, "loaded dialog closed");
	expect(hostOpen()).toBe("false");
	// Closed, but retained: no unmount, no loading shell.
	expect(unmounts).toBe(0);
	expect(text()).not.toContain("Opening settings");

	await act(async () => button("Open settings").click());
	await until(() => openDialogs().length === 1, "reopened");
	expect(dialogName(openDialogs()[0] as HTMLElement)).toBe("Loaded settings");
	expect(search()?.value).toBe("privacy");
	expect(loads).toBe(1);
	expect(mounts).toBe(1);
	expect(unmounts).toBe(0);
});

test("the loading dialog's title and description follow the active language pack", async () => {
	await mount(FRENCH);
	await act(async () => button("Open settings").click());
	await until(() => openDialogs().length === 1, "loading dialog");
	const loading = openDialogs()[0] as HTMLElement;
	expect(dialogName(loading)).toBe("Réglages");
	expect(dialogDescription(loading)).toBe("Ouverture des réglages");
	expect(text()).not.toContain("Opening settings");
});
