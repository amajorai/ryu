// The handoff between a settings SEARCH RESULT and the row it names.
//
// Clicking a result has to do two things that happen at different times: switch
// the dialog to the owning section (synchronous), and then scroll to + highlight
// the row (only possible once that section has mounted, which may be a few
// frames later, or a few hundred ms later for a pane that fetches first).
//
// So the click leaves a one-shot "reveal this" request here, and the content
// pane picks it up after it renders. If the row never appears — a row behind a
// disclosure, a pane that failed to load — the user still ends up on the right
// section, which is the outcome the old tab-only search gave at best.
//
// Anchoring is by `data-setting-id` when a row carries one, falling back to the
// row's visible title text. The fallback is the common path on purpose: threading
// an id through several hundred existing rows would be a large mechanical diff
// for no user-visible gain, and the index stores labels verbatim precisely so the
// text match is exact rather than fuzzy.

import type { SettingsEntry } from "./settings-index.ts";

/** The pending reveal, if a result was clicked and not yet consumed. */
let pending: SettingsEntry | null = null;

/**
 * The reveal a content pane claimed and is still polling for. A pane can
 * claim before the section's body renders (the Gateway dialog shows a skeleton
 * until its status loads), so a sub-paged body that mounts later still has to
 * learn which page to open while the poll is running.
 */
let revealing: SettingsEntry | null = null;

/**
 * Panes that need to know a reveal was requested BEFORE it is consumed.
 *
 * A pane split into sub-pages has to open the right one first: the row is not in
 * the DOM until it does, and {@link revealSettingWhenReady} gives up after five
 * seconds of polling. Consuming here would race the content pane for the same
 * one-shot request, so these listeners only ever peek.
 */
const listeners = new Set<(entry: SettingsEntry) => void>();

/** Ask the next render of `entry.section` to scroll to and flash that row. */
export function requestSettingReveal(entry: SettingsEntry): void {
	pending = entry;
	for (const listener of listeners) {
		listener(entry);
	}
}

/**
 * Read the pending reveal for `section` WITHOUT consuming it, or else the one
 * a content pane is still polling for. For a sub-paged pane deciding which
 * page to open; the content pane still consumes it.
 */
export function peekSettingReveal(section: string): SettingsEntry | null {
	if (pending?.section === section) {
		return pending;
	}
	return revealing?.section === section ? revealing : null;
}

/** Subscribe to reveal requests. Returns an unsubscribe function. */
export function subscribeSettingReveal(
	listener: (entry: SettingsEntry) => void
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Take the pending reveal if it targets `section`. One-shot: a second caller
 * gets null, so two mounted panes cannot both try to claim it.
 */
export function consumeSettingReveal(section: string): SettingsEntry | null {
	if (!pending || pending.section !== section) {
		return null;
	}
	const entry = pending;
	pending = null;
	return entry;
}

/** Drop any pending reveal (the dialog closed, the user navigated away). */
export function clearSettingReveal(): void {
	pending = null;
	revealing = null;
}

/** Normalized text of a node, for comparing against an indexed label. */
function textOf(el: Element): string {
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Find the DOM node for an entry inside `root`, or null.
 *
 * Order matters: an explicit `data-setting-id` is authoritative, a row title is
 * the normal case, and a section header is the last resort (it lands the user in
 * the right group when the row itself is behind a disclosure or virtualized).
 */
export function findSettingElement(
	entry: SettingsEntry,
	root: ParentNode
): HTMLElement | null {
	const byId = root.querySelector<HTMLElement>(
		`[data-setting-id="${CSS.escape(entry.id)}"]`
	);
	if (byId) {
		return byId;
	}
	const label = entry.label.replace(/\s+/g, " ").trim();
	for (const title of root.querySelectorAll<HTMLElement>(
		'[data-slot="item-title"]'
	)) {
		if (textOf(title) === label) {
			// Highlight the whole row, not just its title text.
			return title.closest<HTMLElement>('[data-slot="item"]') ?? title;
		}
	}
	if (entry.group) {
		for (const heading of root.querySelectorAll<HTMLElement>("h3")) {
			if (textOf(heading) === entry.group) {
				return heading;
			}
		}
	}
	return null;
}

/**
 * Scroll `el` into view and pulse a highlight around it.
 *
 * Uses the Web Animations API rather than a utility class so the effect cannot
 * be dropped by a CSS purge and needs no cleanup if the node unmounts mid-pulse.
 */
export function flashSetting(el: HTMLElement): void {
	el.scrollIntoView({ behavior: "smooth", block: "center" });
	// `currentColor`-derived ring: reads correctly in both themes without
	// hardcoding a palette value.
	el.animate?.(
		[
			{
				boxShadow: "0 0 0 0 color-mix(in oklab, currentColor 45%, transparent)",
			},
			{
				boxShadow:
					"0 0 0 3px color-mix(in oklab, currentColor 45%, transparent)",
			},
			{
				boxShadow:
					"0 0 0 3px color-mix(in oklab, currentColor 45%, transparent)",
			},
			{
				boxShadow: "0 0 0 0 color-mix(in oklab, currentColor 0%, transparent)",
			},
		],
		{ duration: 1600, easing: "ease-out" }
	);
}

/**
 * How long to keep looking for a row that has not mounted yet. Long enough for
 * a pane that fetches before it renders its body (the Gateway dialog's status)
 * and then opens the row's sub-page.
 */
const REVEAL_TIMEOUT_MS = 5000;

/**
 * Poll for the entry's element until it exists or the deadline passes, then
 * scroll + flash it. Returns a cancel function (call it on unmount).
 *
 * While it polls, {@link peekSettingReveal} still reports the entry, so a
 * sub-paged body that renders after the claim opens the right page.
 *
 * `requestAnimationFrame` rather than an interval: it stops on its own while the
 * window is backgrounded, and it lines the scroll up with a paint.
 */
export function revealSettingWhenReady(
	entry: SettingsEntry,
	root: ParentNode,
	now: () => number = () => performance.now()
): () => void {
	const deadline = now() + REVEAL_TIMEOUT_MS;
	let frame = 0;
	let cancelled = false;
	revealing = entry;
	const settle = () => {
		if (revealing === entry) {
			revealing = null;
		}
	};
	const tick = () => {
		if (cancelled) {
			return;
		}
		const el = findSettingElement(entry, root);
		if (el) {
			settle();
			flashSetting(el);
			return;
		}
		if (now() >= deadline) {
			settle();
			return;
		}
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);
	return () => {
		cancelled = true;
		cancelAnimationFrame(frame);
		settle();
	};
}
