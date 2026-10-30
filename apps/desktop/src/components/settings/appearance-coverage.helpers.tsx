// Page-specific queries shared by the split Appearance coverage suites.

import { act } from "react";
import { z } from "zod";
import {
	buttonNamed,
	consumer,
	flush,
	press,
	row,
	shadowOf,
	tabElement,
	treePreviewHost,
	visibleText,
} from "./appearance-coverage.dom.tsx";

// ── Notification layout ────────────────────────────────────────────────────
export function notificationSlider() {
	return row("Notification layout").querySelector<HTMLElement>(
		'[role="slider"][aria-label="Notification layout"]'
	)!;
}

// ── Seasonal effects ───────────────────────────────────────────────────────
export function previewButton() {
	return buttonNamed(
		visibleText().includes("Previewing…") ? "Previewing…" : "Preview"
	);
}

// ── Usage meter ────────────────────────────────────────────────────────────
export function composerMeter() {
	return consumer("usage-composer").querySelector<HTMLElement>(
		'[aria-label^="Session:"]'
	);
}

export function sidebarMeter() {
	return consumer("usage-sidebar").querySelector<HTMLElement>(
		'[aria-label^="Session:"]'
	);
}

// ── Diff viewer ────────────────────────────────────────────────────────────
export function diffPreview() {
	return shadowOf(tabElement(), "diffs-container");
}

export function previewPre() {
	return diffPreview().querySelector<HTMLElement>("pre[data-diff]")!;
}

export function consumerDiff() {
	return shadowOf(consumer("diff"), "diffs-container");
}

export function rendered(read: () => unknown) {
	try {
		return Boolean(read());
	} catch {
		return false;
	}
}

/** The viewer's generated theme stylesheet inside its shadow root. */
export function themeCss() {
	return (
		diffPreview().querySelector("style[data-theme-css]")?.textContent ?? ""
	);
}

export function tokenColor(
	scope: ShadowRoot,
	token: string,
	side: "light" | "dark"
) {
	const span = Array.from(
		scope.querySelectorAll<HTMLElement>("span[style]")
	).find((candidate) => candidate.textContent?.trim() === token);
	return span?.style.getPropertyValue(`--diffs-token-${side}`) ?? "";
}

// ── Layout & sizing ────────────────────────────────────────────────────────
export function slider(label: string) {
	const match = tabElement().querySelector<HTMLElement>(
		`[role="slider"][aria-label="${label}"]`
	);
	if (!match) {
		throw new Error(`No "${label}" slider`);
	}
	return match;
}

export async function stepSlider(label: string, key: string) {
	await act(async () => slider(label).focus());
	await press(key);
}

export function rootStyle(property: string) {
	return document.documentElement.style.getPropertyValue(property);
}

export const themeNumbersSchema = z
	.object({
		cardSpacing: z.number().nullable(),
		contrast: z.number(),
		radius: z.number(),
		scale: z.number(),
		spacing: z.number(),
	})
	.passthrough();

// ── Diff layout and file-tree behaviour ────────────────────────────────────
export function treeShadow() {
	return treePreviewHost().shadowRoot!;
}

export function treeItem(path: string) {
	return treeShadow().querySelector<HTMLElement>(`[data-item-path="${path}"]`);
}

export function workspaceTreeItems() {
	const host = consumer("workspace-tree").querySelector("file-tree-container");
	return Array.from(
		host?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? []
	).map((item) => item.getAttribute("data-item-path"));
}

export async function pressOn(target: HTMLElement, key: string) {
	await act(async () => {
		target.focus();
		target.click();
	});
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				composed: true,
				key,
			})
		);
	});
	await flush(60);
}

// ── Chat detail, message preferences and motion ────────────────────────────
export const transcriptSchema = z
	.object({
		animationsEnabled: z.boolean(),
		expandCodeBlocks: z.boolean(),
		expandCommands: z.boolean(),
		expandFileEdits: z.boolean(),
		groupToolUses: z.boolean(),
		hideToolDetail: z.boolean(),
		inferenceStats: z.boolean(),
		markdownComposer: z.boolean(),
		openAtBottom: z.boolean(),
		pinUserMessage: z.boolean(),
		streamAnimation: z.boolean(),
	})
	.passthrough();

export function transcript() {
	return transcriptSchema.parse(
		JSON.parse(consumer("transcript").textContent ?? "{}")
	);
}

export function detailSlider() {
	return row("Detail level").querySelector<HTMLElement>(
		'[role="slider"][aria-label="Detail level"]'
	)!;
}

/** The level named above the track — what a sighted user reads. */
export function detailCaption() {
	return row("Detail level").querySelector(".justify-end > span")?.textContent;
}
