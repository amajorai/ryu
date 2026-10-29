// DOM helpers for the unswept-a coverage suites (`AnalyticsInspector`,
// `CopyableId`, `DeferredSettingsDialog`, `RyuAppsTab`, `ServicesOrgSwitcher`).
// They only find and drive rendered controls; every effect the suites assert
// comes from a real loopback HTTP fixture, real browser storage, the real
// clipboard, or the shipping component's own rendered output.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * Register happy-dom for React while keeping Bun's native networking globals,
 * so the shipping SDKs talk to a real loopback socket. Must run before React
 * or any client module is imported.
 */
export function registerDomWithNativeNetworking(): void {
	const natives = {
		AbortController: globalThis.AbortController,
		AbortSignal: globalThis.AbortSignal,
		Blob: globalThis.Blob,
		fetch: globalThis.fetch,
		FormData: globalThis.FormData,
		Headers: globalThis.Headers,
		ReadableStream: globalThis.ReadableStream,
		Request: globalThis.Request,
		Response: globalThis.Response,
		TextDecoderStream: globalThis.TextDecoderStream,
		TransformStream: globalThis.TransformStream,
		URL: globalThis.URL,
		WritableStream: globalThis.WritableStream,
	};
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register({ url: "http://localhost/" });
	}
	Object.assign(globalThis, natives);
	window.fetch = natives.fetch;
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
}

/**
 * The Web Animations entry points happy-dom lacks. Base UI's ScrollArea and
 * TextSwap labels call them; a finished animation is the honest stand-in.
 */
export function installAnimationApis(): void {
	if (!("getAnimations" in Element.prototype)) {
		Object.defineProperty(Element.prototype, "getAnimations", {
			configurable: true,
			value: () => [],
		});
	}
	if (!("animate" in Element.prototype)) {
		Object.defineProperty(Element.prototype, "animate", {
			configurable: true,
			value() {
				const animation = {
					cancel: () => undefined,
					finished: Promise.resolve(),
					onfinish: null as null | (() => void),
				};
				setTimeout(() => animation.onfinish?.(), 0);
				return animation;
			},
		});
	}
}

export function text(): string {
	return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

/** Let pending fetches and effects run without waiting for a condition. */
export async function flush(rounds = 6): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

/** Poll the rendered tree until `predicate` holds, flushing React between tries. */
export async function until(
	predicate: () => boolean,
	label: string,
	budgetMs = 5000,
	describe: () => string = text
): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`${label} did not settle: ${describe()}`);
		}
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
		throw new Error(`Missing button ${name}: ${text()}`);
	}
	return found;
}

export function isDisabled(control: HTMLElement): boolean {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		(control instanceof HTMLButtonElement && control.disabled)
	);
}

export async function click(control: HTMLElement): Promise<void> {
	await act(async () => control.click());
	await flush(4);
}

/** Dispatch a keydown/keyup pair on `target` (default: the focused element). */
export async function press(
	key: string,
	target: Element | null = document.activeElement
): Promise<void> {
	if (!target) {
		throw new Error(`No focused element for ${key}`);
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
		target.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key })
		);
	});
	await flush(4);
}

/** Open dialogs (closed popups linger with `data-closed` for an exit frame). */
export function openDialogs(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
		(dialog) => !dialog.hasAttribute("data-closed")
	);
}

/** The accessible name of a dialog from its `aria-labelledby` target. */
export function dialogName(dialog: HTMLElement): string {
	const ids = dialog.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
	return ids
		.map((id) => normalized(document.getElementById(id)))
		.join(" ")
		.trim();
}

/** The accessible description of a dialog from its `aria-describedby` target. */
export function dialogDescription(dialog: HTMLElement): string {
	const ids = dialog.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
	return ids
		.map((id) => normalized(document.getElementById(id)))
		.join(" ")
		.trim();
}
