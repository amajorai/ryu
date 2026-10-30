// Mounting, DOM queries and the shared lifecycle for the split Appearance
// coverage suites. See appearance-coverage.harness.tsx for the Core fixture.

import { afterAll, afterEach, beforeEach, setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import {
	AppearanceTab,
	AppSurfaceProvider,
	CONSUMERS,
	type ConsumerName,
	clearSettingReveal,
	exchanges,
	ownsDomRegistration,
	previewSeasonalTheme,
	resetUsageBarPrefs,
	server,
	setChatPickerPlacement,
	ThemeProvider,
	undeclared,
	useProductModeStore,
} from "./appearance-coverage.harness.tsx";

// ── Mounting ───────────────────────────────────────────────────────────────
let root: Root | null = null;
let element: HTMLDivElement | null = null;
let consumerRoot: Root | null = null;
let consumerElement: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

export function providers(children: ReactNode) {
	return (
		<MemoryRouter>
			<QueryClientProvider client={queryClient!}>
				<AppSurfaceProvider surface="desktop">
					<ThemeProvider
						attribute="class"
						defaultTheme="light"
						enableSystem={false}
					>
						{children}
					</ThemeProvider>
				</AppSurfaceProvider>
			</QueryClientProvider>
		</MemoryRouter>
	);
}

// ── DOM helpers ────────────────────────────────────────────────────────────
export function visibleText(node: Element | null = element) {
	if (!node) {
		return "";
	}
	const clone = node.cloneNode(true) as Element;
	for (const script of clone.querySelectorAll("script")) {
		script.remove();
	}
	return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

export async function settle(
	predicate: () => boolean,
	label = predicate.toString()
) {
	for (let count = 0; count < 200 && !predicate(); count += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	if (!predicate()) {
		throw new Error(`Condition not reached: ${label}`);
	}
}

export async function flush(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

export async function mountTab() {
	element = document.createElement("div");
	element.dataset.surface = "appearance";
	document.body.append(element);
	root = createRoot(element);
	await act(async () => root!.render(providers(<AppearanceTab />)));
	await settle(() => visibleText().includes("Customize"), "Customize index");
}

export async function unmountTab() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
}

export async function mountConsumers(names: ConsumerName[]) {
	consumerElement = document.createElement("div");
	consumerElement.dataset.surface = "consumers";
	document.body.append(consumerElement);
	consumerRoot = createRoot(consumerElement);
	await act(async () =>
		consumerRoot!.render(providers(names.map((name) => CONSUMERS[name]())))
	);
}

export async function unmountConsumers() {
	if (consumerRoot) {
		await act(async () => consumerRoot!.unmount());
	}
	consumerRoot = null;
	consumerElement?.remove();
	consumerElement = null;
}

export function buttonNamed(name: string, scope: ParentNode = element!) {
	const matches = Array.from(
		scope.querySelectorAll<HTMLButtonElement>("button")
	).filter(
		(candidate) =>
			(candidate.getAttribute("aria-label") ??
				candidate.textContent?.replace(/\s+/g, " ").trim()) === name
	);
	if (matches.length !== 1) {
		throw new Error(`Expected one "${name}" button, found ${matches.length}`);
	}
	return matches[0]!;
}

/** The settings row whose title is exactly `title` (one per mounted page). */
export function row(title: string) {
	const titles = Array.from(
		element!.querySelectorAll('[data-slot="item-title"]')
	).filter((candidate) => candidate.textContent?.trim() === title);
	if (titles.length !== 1) {
		throw new Error(`Expected one "${title}" row, found ${titles.length}`);
	}
	return titles[0]!.closest<HTMLElement>('[data-slot="item"]')!;
}

export function hasRow(title: string) {
	return Array.from(element!.querySelectorAll('[data-slot="item-title"]')).some(
		(candidate) => candidate.textContent?.trim() === title
	);
}

export function switchIn(title: string) {
	return row(title).querySelector<HTMLElement>('[role="switch"]')!;
}

export function isOn(control: HTMLElement) {
	return control.getAttribute("aria-checked") === "true";
}

export function isDisabled(control: HTMLElement) {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		(control instanceof HTMLButtonElement && control.disabled)
	);
}

export function comboIn(title: string) {
	return row(title).querySelector<HTMLButtonElement>('[role="combobox"]')!;
}

export function shown(combo: HTMLElement) {
	return combo.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

/** The listbox of the one select that is open now (closed popups linger). */
export function openListbox() {
	return (
		Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]'))
			.filter(
				(box) =>
					!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
			)
			.at(-1) ?? null
	);
}

export function openOptions() {
	return Array.from(
		openListbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
	);
}

export function optionLabels() {
	return openOptions().map((option) =>
		option.textContent?.replace(/\s+/g, " ").trim()
	);
}

export async function choose(combo: HTMLElement, label: string) {
	await act(async () => combo.click());
	await settle(() => optionLabels().includes(label), `option ${label}`);
	const option = openOptions().find(
		(candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === label
	)!;
	await act(async () => option.click());
	await settle(
		() => combo.getAttribute("aria-expanded") === "false",
		`listbox for ${label} closed`
	);
	await flush();
}

export async function toggle(control: HTMLElement) {
	await act(async () => control.click());
	await flush();
}

export async function press(key: string) {
	const target = document.activeElement;
	if (!target) {
		throw new Error("No focused element for keyboard input");
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
		target.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key })
		);
	});
	await flush(20);
}

export async function openPage(title: string) {
	await act(async () => buttonNamed(title).click());
	await settle(
		() => element!.querySelector("h3")?.textContent === title,
		`page ${title}`
	);
}

export async function backToIndex() {
	await act(async () => buttonNamed("Appearance").click());
	await settle(() => visibleText().includes("Customize"), "index");
}

export function indexRows() {
	return Array.from(
		element!.querySelectorAll<HTMLButtonElement>(
			'[data-slot="item-title"] > button'
		)
	).map((button) => button.textContent?.trim());
}

export function consumer(name: string) {
	return consumerElement!.querySelector<HTMLElement>(
		`[data-consumer="${name}"]`
	)!;
}

/**
 * Whether a DOM query matched. Assertions compare this boolean rather than the
 * node itself, so a failure reports true/false instead of serialising a
 * happy-dom element tree.
 */
export function present(node: Element | null | undefined) {
	return node !== null && node !== undefined;
}

export function storedJson(key: string): unknown {
	const raw = localStorage.getItem(key);
	return raw === null ? null : JSON.parse(raw);
}

export function shadowOf(scope: Element, selector: string) {
	const host = scope.querySelector(selector);
	if (!host?.shadowRoot) {
		throw new Error(`No rendered shadow root for ${selector}`);
	}
	return host.shadowRoot;
}

export function treePreviewHost() {
	return element!.querySelector<HTMLElement>("file-tree-container")!;
}

export function treeItems() {
	const host = treePreviewHost();
	return Array.from(
		host?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? []
	).map((item) => item.getAttribute("data-item-path"));
}

export const PAGE_TITLES = [
	"Language & vibe",
	"Layout & text",
	"Motion & effects",
	"Interface",
	"Chat view",
	"Interfaces",
	"Usage meter",
	"Diff viewer",
	"File tree",
	"Reset",
];

/** The mounted Appearance tab's host element. */
export function tabElement(): HTMLDivElement {
	if (!element) {
		throw new Error("The Appearance tab is not mounted");
	}
	return element;
}

/**
 * Mount the tab without waiting for the Customize index — for a reveal that
 * lands straight on a sub-page.
 */
export async function mountTabBare() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () => root!.render(providers(<AppearanceTab />)));
}

/** The per-case reset and the per-file teardown every split suite shares. */
export function registerAppearanceCoverageLifecycle() {
	beforeEach(() => {
		localStorage.clear();
		// The Interfaces page is listed only when a workspace interface can be opened.
		useProductModeStore.setState({ osAccess: true });
		resetUsageBarPrefs();
		setChatPickerPlacement("composer");
		localStorage.clear();
		exchanges.length = 0;
		undeclared.length = 0;
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		localStorage.setItem("appearance-coverage-unrelated", "keep-me");
	});

	afterEach(async () => {
		clearSettingReveal();
		previewSeasonalTheme(null);
		await unmountTab();
		await unmountConsumers();
		queryClient?.clear();
		// Let a debounced theme publication from this case land before the next.
		await flush(450);
		for (const property of ["--font-sans", "--font-heading", "--font-code"]) {
			document.documentElement.style.removeProperty(property);
		}
	});

	afterAll(async () => {
		await server.stop(true);
		setSystemTime();
		if (ownsDomRegistration) {
			await GlobalRegistrator.unregister();
		}
	});
}
