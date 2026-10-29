// DOM helpers for the unswept-b coverage suites (`SettingsSearchResults`,
// `TrainingDataNotice`, `StatsTab`, `SpacesSettings`). They only find and drive
// rendered controls; every effect the suites assert comes from a real loopback
// HTTP fixture, the recorded native IPC boundary, or the shipping component's
// own rendered output. Copied from the unswept-a helpers rather than shared, so
// neither suite can change the other's behaviour.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * Register happy-dom for React while keeping Bun's native networking globals,
 * so the shipping clients talk to a real loopback socket. Must run before React
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

export interface NativeCall {
	args: unknown;
	command: string;
}

/**
 * Install a recording stand-in for the Tauri IPC bridge (the native boundary
 * `openExternal` crosses). `fail` makes the next calls reject the way a native
 * command error does. Returns the recorded calls and an uninstall function.
 */
export function installNativeBridge(): {
	calls: NativeCall[];
	failWith: (message: string | null) => void;
	uninstall: () => void;
} {
	const calls: NativeCall[] = [];
	let failure: string | null = null;
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: (command: string, args: unknown) => {
			calls.push({ args, command });
			return failure === null
				? Promise.resolve(undefined)
				: Promise.reject(new Error(failure));
		},
		transformCallback: () => 0,
	});
	return {
		calls,
		failWith: (message) => {
			failure = message;
		},
		uninstall: () => {
			Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		},
	};
}

export function text(): string {
	return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

export function normalized(element: Element | null | undefined): string {
	return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
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

/**
 * happy-dom has no WebGL or 2D canvas, and the shared `metal-fx` ring behind
 * `EmployeeBadge` throws without them. This installs an inert rendering
 * backend for `canvas.getContext`: every drawing call is a no-op that reports
 * success, so the badge mounts and nothing it draws is asserted. It is
 * an environment stand-in (like happy-dom itself), not a substitute for any
 * logic a suite asserts. Returns the restore function.
 */
export function installInertWebgl(): () => void {
	const handle = (): object => ({});
	const context: object = new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property !== "string") {
					return undefined;
				}
				if (/^[A-Z0-9_]+$/.test(property)) {
					return 1;
				}
				if (property === "canvas") {
					return document.createElement("canvas");
				}
				if (property === "getExtension") {
					return () => null;
				}
				if (property === "checkFramebufferStatus") {
					return () => 1;
				}
				if (property.startsWith("create")) {
					return handle;
				}
				if (property.startsWith("get")) {
					return () => (property.endsWith("Location") ? 0 : true);
				}
				return () => undefined;
			},
		}
	);
	// happy-dom's OffscreenCanvas is not an EventTarget, and `metal-fx` prefers
	// it when it exists, so the stand-in hides it and serves the DOM canvas.
	const offscreen = Reflect.get(globalThis, "OffscreenCanvas");
	Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	const prototype = HTMLCanvasElement.prototype;
	const original = prototype.getContext;
	Object.defineProperty(prototype, "getContext", {
		configurable: true,
		value(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
			if (type === "webgl" || type === "experimental-webgl") {
				return context;
			}
			// The ring also composites through a 2D canvas, which happy-dom
			// does not implement either.
			return Reflect.apply(original, this, [type, ...rest]) ?? context;
		},
		writable: true,
	});
	return () => {
		Object.defineProperty(prototype, "getContext", {
			configurable: true,
			value: original,
			writable: true,
		});
		if (offscreen !== undefined) {
			Reflect.set(globalThis, "OffscreenCanvas", offscreen);
		}
	};
}
