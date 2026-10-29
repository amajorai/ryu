// DOM helpers for the connections-providers coverage suites
// (`ConnectionsTab`, `IntegrationsTab`, `CapabilityProvidersSettings`,
// `ComposioBillingSettings`). They only find and drive rendered controls; every
// effect the suites assert comes from a real loopback HTTP fixture or the
// in-process Tauri IPC bridge each suite owns.
import { act } from "react";

/** Poll the rendered tree until `predicate` holds, flushing React between tries. */
export async function settle(
	predicate: () => boolean,
	label: string,
	describe: () => string = () => document.body.textContent ?? ""
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${describe()}`);
}

/** Let pending fetches and effects run without waiting for a condition. */
export async function flush(rounds = 20): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

/** A control's accessible name: its aria-label, else its trimmed text. */
function accessibleName(element: Element): string {
	return (
		element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
	);
}

export function maybeButton(
	name: string,
	scope: ParentNode = document
): HTMLButtonElement | null {
	return (
		[...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => accessibleName(candidate) === name
		) ?? null
	);
}

export function button(
	name: string,
	scope: ParentNode = document
): HTMLButtonElement {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing button ${name}`);
	}
	return found;
}

export function byPlaceholder<T extends HTMLInputElement = HTMLInputElement>(
	placeholder: string,
	scope: ParentNode = document
): T {
	const found = scope.querySelector<T>(`[placeholder="${placeholder}"]`);
	if (!found) {
		throw new Error(`Missing input with placeholder ${placeholder}`);
	}
	return found;
}

export function byLabel<T extends HTMLElement = HTMLElement>(
	label: string,
	scope: ParentNode = document
): T | null {
	return scope.querySelector<T>(`[aria-label="${label}"]`);
}

/** The settings row whose title is exactly `title`. */
export function settingsRow(
	title: string,
	scope: ParentNode = document
): HTMLElement | null {
	return (
		[...scope.querySelectorAll<HTMLElement>('[data-slot="item"]')].find(
			(row) =>
				row.querySelector('[data-slot="item-title"]')?.textContent?.trim() ===
				title
		) ?? null
	);
}

/** The visible value a settings row shows in its action column. */
export function rowAction(title: string, scope: ParentNode = document): string {
	const row = settingsRow(title, scope);
	if (!row) {
		throw new Error(`Missing settings row ${title}`);
	}
	return (
		row.querySelector('[data-slot="item-actions"]')?.textContent?.trim() ?? ""
	);
}

/** The SettingsSection whose header reads exactly `title`. */
export function settingsSection(
	title: string,
	scope: ParentNode = document
): HTMLElement | null {
	const heading = [...scope.querySelectorAll<HTMLElement>("h3")].find(
		(candidate) => candidate.textContent?.trim() === title
	);
	return heading?.parentElement?.parentElement ?? null;
}

/**
 * The footer caption a SettingsGroup renders under the card that holds the row
 * titled `title` (SettingsItem descriptions are not rendered inside the row).
 */
export function rowCaption(
	title: string,
	scope: ParentNode = document
): string {
	const card = settingsRow(title, scope)?.closest('[data-slot="item-group"]');
	const caption = card?.nextElementSibling;
	return caption?.tagName === "P" ? (caption.textContent ?? "") : "";
}

/** The `role="dialog"` element whose heading reads `title`. */
export function dialogTitled(title: string): HTMLElement | null {
	return (
		[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
			(dialog) =>
				[...dialog.querySelectorAll("h2")].some(
					(heading) => heading.textContent?.trim() === title
				)
		) ?? null
	);
}

export async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.click();
	});
}

/** Set an input's value through the native setter so React sees an input event. */
export async function typeInto(
	element: HTMLInputElement,
	value: string
): Promise<void> {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export async function pressKey(
	element: HTMLElement,
	key: string
): Promise<void> {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
		element.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key })
		);
	});
}

/** Toast titles currently rendered by the shared sileo Toaster. */
export function toastText(): string {
	return [...document.querySelectorAll("[data-sileo-toast]")]
		.map((toast) => toast.textContent ?? "")
		.join(" | ");
}
