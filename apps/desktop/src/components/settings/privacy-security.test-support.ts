// DOM helpers for the privacy-security coverage suites (`PrivacySettings`,
// `EncryptionSettings`, `EmailAlertsSettings`, `SettingsSyncTab`). They only
// find and drive rendered controls; every effect the suites assert comes from a
// real loopback HTTP fixture, real browser storage, or the in-process Tauri IPC
// bridge each suite owns.
import { act } from "react";

/** Poll the rendered tree until `predicate` holds, flushing React between tries. */
export async function settle(
	predicate: () => boolean,
	label: string,
	describe: () => string = () => document.body.textContent ?? ""
): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt += 1) {
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
export async function flush(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function normalized(element: Element | null | undefined): string {
	return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A control's accessible name: its aria-label, else its trimmed text. */
function accessibleName(element: Element): string {
	return element.getAttribute("aria-label") ?? normalized(element);
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

/** The settings row (`SettingsItem`) whose title reads exactly `title`. */
export function maybeRow(
	title: string,
	scope: ParentNode = document
): HTMLElement | null {
	return (
		[...scope.querySelectorAll<HTMLElement>('[data-slot="item"]')].find(
			(item) =>
				normalized(item.querySelector('[data-slot="item-title"]')) === title
		) ?? null
	);
}

export function row(title: string, scope: ParentNode = document): HTMLElement {
	const found = maybeRow(title, scope);
	if (!found) {
		throw new Error(`Missing settings row ${title}`);
	}
	return found;
}

export function rowText(title: string): string {
	return normalized(row(title));
}

export function switchIn(title: string): HTMLElement {
	const control = row(title).querySelector<HTMLElement>('[role="switch"]');
	if (!control) {
		throw new Error(`Missing switch in ${title}`);
	}
	return control;
}

export function isOn(control: HTMLElement): boolean {
	return control.getAttribute("aria-checked") === "true";
}

export function isDisabled(control: HTMLElement): boolean {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		(control instanceof HTMLButtonElement && control.disabled) ||
		(control instanceof HTMLInputElement && control.disabled)
	);
}

export async function click(control: HTMLElement): Promise<void> {
	await act(async () => control.click());
	await flush(4);
}

/** Type into a React-controlled input through the native value setter. */
export async function fill(
	input: HTMLInputElement,
	value: string
): Promise<void> {
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Move focus away from `input` so its React `onBlur` handler commits. */
export async function blur(input: HTMLInputElement): Promise<void> {
	await act(async () => {
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		input.blur();
	});
	await flush(4);
}

export function input(selector: string): HTMLInputElement {
	const found = document.querySelector<HTMLInputElement>(selector);
	if (!found) {
		throw new Error(`Missing input ${selector}`);
	}
	return found;
}

/** The listbox of the one select that is open now (closed popups linger). */
function openListbox(): HTMLElement | null {
	return (
		[...document.querySelectorAll<HTMLElement>('[role="listbox"]')]
			.filter(
				(box) =>
					!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
			)
			.at(-1) ?? null
	);
}

export function openOptionLabels(): string[] {
	return [
		...(openListbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
	].map((option) => normalized(option));
}

export function comboIn(title: string): HTMLElement {
	const combo = row(title).querySelector<HTMLElement>('[role="combobox"]');
	if (!combo) {
		throw new Error(`Missing select in ${title}`);
	}
	return combo;
}

export function shownValue(combo: HTMLElement): string {
	return normalized(combo);
}

/**
 * Open a Base UI select and pick the option whose text is `label`. Resolves to
 * the option labels the open list offered, so a caller can pin the exact set.
 */
export async function choose(
	combo: HTMLElement,
	label: string
): Promise<string[]> {
	await act(async () => combo.click());
	await settle(
		() => openOptionLabels().includes(label),
		`option ${label}`,
		() => openOptionLabels().join(" | ")
	);
	const offered = openOptionLabels();
	const option = [
		...(openListbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
	].find((candidate) => normalized(candidate) === label);
	if (!option) {
		throw new Error(`Missing option ${label}`);
	}
	await act(async () => option.click());
	await settle(
		() => combo.getAttribute("aria-expanded") !== "true",
		`listbox for ${label} closed`
	);
	await flush(4);
	return offered;
}

/** Rendered toast text (the shipping sileo Toaster). */
export function toasts(): string {
	return normalized(document.body);
}
