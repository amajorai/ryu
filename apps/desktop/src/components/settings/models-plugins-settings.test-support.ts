// DOM and native-HTTP helpers for the models-plugins-settings coverage suites
// (`EntitySettings`, `McpSettingsPanel`, `OAuthAccountPoolControls`,
// `ProviderLoginDialog`, `ResourcePermissions`, `NodePermissionsSettings`,
// `AgentModelsSettings`). They only find and drive rendered controls and run a
// loopback Core peer; every effect the suites assert comes from that peer's
// request ledger and state, or from the shipping component's rendered output.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

/**
 * Register happy-dom for React while keeping Bun's native networking globals,
 * so the shipping API clients talk to a real loopback socket. Must run before
 * React or any client module is imported.
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
		WebSocket: globalThis.WebSocket,
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
 * The Web Animations entry points happy-dom lacks. Base UI's collapsibles,
 * selects and dialogs call them; a finished animation is the honest stand-in.
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

export function normalized(element: Element | null | undefined): string {
	return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function text(): string {
	return normalized(document.body);
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
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy) {
		return labelledBy
			.split(/\s+/)
			.map((id) => normalized(document.getElementById(id)))
			.join(" ")
			.trim();
	}
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

export function buttons(name: string, scope: ParentNode = document) {
	return [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
		(candidate) => accessibleName(candidate) === name
	);
}

/** A control found by its accessible name (aria-label / aria-labelledby). */
export function byName<T extends HTMLElement = HTMLElement>(
	name: string,
	selector = "*"
): T {
	const found = [...document.querySelectorAll<T>(selector)].find(
		(candidate) =>
			(candidate.hasAttribute("aria-label") ||
				candidate.hasAttribute("aria-labelledby")) &&
			accessibleName(candidate) === name
	);
	if (!found) {
		throw new Error(`Missing control ${name}: ${text()}`);
	}
	return found;
}

export function isDisabled(control: HTMLElement): boolean {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		((control instanceof HTMLButtonElement ||
			control instanceof HTMLInputElement ||
			control instanceof HTMLSelectElement) &&
			control.disabled)
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

/** Type into a React-controlled input through the native value setter. */
export async function fill(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string
): Promise<void> {
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			input,
			value
		);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush(2);
}

/** Pick a native `<select>` option the way a user's choice reaches React. */
export async function selectNative(
	select: HTMLSelectElement,
	value: string
): Promise<void> {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value"
		)?.set?.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush(4);
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

/** Open a Base UI select and pick the option whose text is `label`. */
export async function choose(
	combo: HTMLElement,
	label: string
): Promise<string[]> {
	await act(async () => combo.click());
	await until(
		() => openOptionLabels().includes(label),
		`option ${label}`,
		5000,
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
	await until(
		() => combo.getAttribute("aria-expanded") !== "true",
		`listbox for ${label} closed`
	);
	await flush(4);
	return offered;
}

/** Open dialogs (closed popups linger with `data-closed` for an exit frame). */
export function openDialogs(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
		(dialog) => !dialog.hasAttribute("data-closed")
	);
}

/** One request the loopback Core peer received. */
export interface PeerCall {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	search: string;
	userJwt: string | null;
}

export interface PeerReply {
	body?: unknown;
	status?: number;
}

export type PeerRoute = (
	call: PeerCall
) => PeerReply | Response | Promise<PeerReply | Response> | undefined;

/**
 * A loopback HTTP peer standing in for Core's REST surface. Every request is
 * recorded with its bearer, identity header and decoded body. A request no
 * route answers is recorded in `unexpected` and refused with 404, so a case
 * can prove the component made no undeclared call.
 */
export interface CorePeer {
	calls: PeerCall[];
	route: PeerRoute;
	stop: () => void;
	unexpected: string[];
	url: string;
}

export function startCorePeer(route: PeerRoute): CorePeer {
	const peer: CorePeer = {
		calls: [],
		route,
		unexpected: [],
		url: "",
		stop: () => undefined,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const raw = request.method === "GET" ? "" : await request.text();
			let body: unknown = null;
			if (raw) {
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
			}
			const call: PeerCall = {
				method: request.method,
				path: decodeURIComponent(url.pathname),
				search: url.search,
				authorization: request.headers.get("authorization"),
				userJwt: request.headers.get("x-ryu-user-jwt"),
				body,
			};
			peer.calls.push(call);
			const reply = await peer.route(call);
			if (reply === undefined) {
				peer.unexpected.push(`${call.method} ${call.path}${call.search}`);
				return Response.json(
					{ error: "undeclared fixture route" },
					{ status: 404 }
				);
			}
			if (reply instanceof Response) {
				return reply;
			}
			return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
		},
	});
	peer.url = server.url.origin;
	peer.stop = () => server.stop(true);
	return peer;
}
