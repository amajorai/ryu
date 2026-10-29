import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * DOM driving for the account-billing coverage suites: happy-dom for React,
 * with the native networking globals kept so the shipping clients talk to a
 * real socket, and the few Web Animations entry points happy-dom lacks.
 */
export function installAccountBillingDom(): void {
	const natives = {
		AbortController: globalThis.AbortController,
		AbortSignal: globalThis.AbortSignal,
		Blob: globalThis.Blob,
		fetch: globalThis.fetch,
		File: globalThis.File,
		FormData: globalThis.FormData,
		Headers: globalThis.Headers,
		Request: globalThis.Request,
		Response: globalThis.Response,
		TransformStream: globalThis.TransformStream,
		URL: globalThis.URL,
		WritableStream: globalThis.WritableStream,
	};
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register();
	}
	Object.assign(globalThis, natives);
	window.fetch = natives.fetch;
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	// `TextSwap` (torph) morphs labels with the Web Animations API. Each
	// animation completes on the next task, as a finished animation would.
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
	if (!("getAnimations" in Element.prototype)) {
		Object.defineProperty(Element.prototype, "getAnimations", {
			configurable: true,
			value: () => [],
		});
	}
}

/**
 * Signs `userId` in the way the desktop account vault does (`persistVault` in
 * `lib/auth-client.ts`): the account list, the active account id, and the
 * legacy single-token mirror under `tokenKey` (pass the real `TOKEN_KEY`).
 * Seeding only the legacy token is not a signed-in session any more: account-
 * scoped reads such as `useActiveOrgId` key on `getActiveUserId()`, which reads
 * the vault, and stay disabled without it.
 */
export function signInVaultAccount(
	tokenKey: string,
	token: string,
	userId: string
): void {
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([
			{
				email: `${userId}@example.test`,
				image: null,
				name: null,
				token,
				userId,
			},
		])
	);
	localStorage.setItem("ryu_active_user_id", userId);
	localStorage.setItem(tokenKey, token);
}

export function text(): string {
	return document.body.textContent ?? "";
}

export async function settle(ms = 20): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

export async function until(
	predicate: () => boolean,
	reason: string,
	ms = 8000,
	detail: () => string = () => ""
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`${reason}\n--- page ---\n${text()}\n${detail()}`);
		}
		await settle(15);
	}
}

function buttons(scope: ParentNode): HTMLButtonElement[] {
	return [...scope.querySelectorAll("button")];
}

/** A button by visible label (TextSwap renders its label twice) or aria-label. */
export function maybeButton(
	name: string,
	scope: ParentNode = document.body
): HTMLButtonElement | undefined {
	return (
		buttons(scope).find((item) => {
			const label = (item.textContent ?? "").replace(/\s+/gu, " ").trim();
			return (
				label.length > 0 &&
				(label === name || label.replaceAll(name, "").trim() === "")
			);
		}) ??
		buttons(scope).find((item) => item.getAttribute("aria-label") === name)
	);
}

export function button(
	name: string,
	scope: ParentNode = document.body
): HTMLButtonElement {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing button ${name}\n${text()}`);
	}
	return found;
}

function dialogs(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>(
			'[role="dialog"], [role="alertdialog"]'
		),
	];
}

function dialogName(element: HTMLElement): string {
	const label = element.getAttribute("aria-label");
	if (label) {
		return label;
	}
	const labelledBy = element.getAttribute("aria-labelledby");
	const title = labelledBy ? document.getElementById(labelledBy) : null;
	return title?.textContent?.trim() ?? "";
}

export function hasDialog(name: string): boolean {
	return dialogs().some((item) => dialogName(item) === name);
}

export function dialog(name: string): HTMLElement {
	const found = dialogs().find((item) => dialogName(item) === name);
	if (!found) {
		throw new Error(`Dialog ${name} is not open\n${text()}`);
	}
	return found;
}

export async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.click();
	});
}

export async function type(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
): Promise<void> {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			element,
			value
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export async function press(element: HTMLElement, key: string): Promise<void> {
	await act(async () => {
		element.focus();
		element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
		element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
	});
}

export async function submit(form: HTMLFormElement | null): Promise<void> {
	if (!form) {
		throw new Error("No form to submit");
	}
	await act(async () => {
		form.requestSubmit();
	});
}

export function input(
	selector: string,
	scope: ParentNode = document.body
): HTMLInputElement {
	const found = scope.querySelector(selector);
	if (!(found instanceof HTMLInputElement)) {
		throw new Error(`Missing input ${selector}\n${text()}`);
	}
	return found;
}

export function textarea(
	selector: string,
	scope: ParentNode = document.body
): HTMLTextAreaElement {
	const found = scope.querySelector(selector);
	if (!(found instanceof HTMLTextAreaElement)) {
		throw new Error(`Missing textarea ${selector}\n${text()}`);
	}
	return found;
}
