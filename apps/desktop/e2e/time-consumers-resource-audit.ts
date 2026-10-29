import type { Page } from "@playwright/test";
import { consumerCallsites } from "./time-consumers-source-map.ts";

export interface ConsumerResources {
	errors: string[];
	focus: number;
	storage: number;
	timers: number;
	timezoneObservers: number;
	visibility: number;
}

export async function installConsumerAudit(page: Page): Promise<void> {
	const directory = process.env.RYU_TIME_CONSUMERS_DIST;
	if (!directory) {
		throw new Error("Missing authentic consumer artifact directory");
	}
	await page.addInitScript((callsites) => {
		const errors: string[] = [];
		const timers = new Set<number>();
		const observers = new Set<MutationObserver>();
		const listeners: Array<{
			target: EventTarget;
			type: string;
			handler: EventListenerOrEventListenerObject;
			capture: boolean;
		}> = [];
		const fail = (message: string): never => {
			errors.push(message);
			throw new Error(message);
		};
		const ownership = (): "day" | "timezone" | null => {
			let unknown = false;
			for (const frame of (
				new Error("Original consumer resource callsite").stack ?? ""
			).split("\n")) {
				const match = /(https?:\/\/[^\s)]+\/([^/\s)]+\.js)):(\d+):(\d+)/.exec(
					frame
				);
				if (!match) {
					continue;
				}
				const [, url, file, line, column] = match;
				if (!(url && file && line && column)) {
					return fail("Malformed actual consumer resource stack");
				}
				const address = new URL(url);
				if (
					address.origin !== location.origin ||
					!address.pathname.includes("/assets/")
				) {
					continue;
				}
				const site = callsites.find(
					(candidate) =>
						candidate.file === file &&
						candidate.line === Number(line) &&
						candidate.start <= Number(column) - 1 &&
						(candidate.end === null || Number(column) - 1 < candidate.end)
				);
				if (site?.owner === "day" || site?.owner === "timezone") {
					return site.owner;
				}
				if (!site || site.owner === null) {
					unknown = true;
				}
			}
			if (unknown) {
				return fail(
					"Unattributed actual consumer resource in emitted static graph"
				);
			}
			return null;
		};
		const originalSet = window.setTimeout.bind(window);
		const originalClear = window.clearTimeout.bind(window);
		const originalAdd = EventTarget.prototype.addEventListener;
		const originalRemove = EventTarget.prototype.removeEventListener;
		const OriginalObserver = window.MutationObserver;
		window.setTimeout = ((
			handler: TimerHandler,
			delay?: number,
			...args: unknown[]
		) => {
			if (ownership() !== "day") {
				return originalSet(handler, delay, ...args);
			}
			if (typeof handler !== "function") {
				return fail("Unexpected nonfunction shipping day timer");
			}
			const handle = originalSet(() => {
				timers.delete(handle);
				Reflect.apply(handler, window, args);
			}, delay);
			timers.add(handle);
			return handle;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((handle?: number) => {
			originalClear(handle);
			if (handle !== undefined) {
				timers.delete(handle);
			}
		}) as typeof window.clearTimeout;
		const captureOf = (
			options?: boolean | AddEventListenerOptions | EventListenerOptions
		) => (typeof options === "boolean" ? options : Boolean(options?.capture));
		EventTarget.prototype.addEventListener = function (type, handler, options) {
			const owner = ownership();
			const result = Reflect.apply(originalAdd, this, [type, handler, options]);
			if (
				handler &&
				((owner === "day" &&
					(type === "focus" || type === "visibilitychange")) ||
					(owner === "timezone" && type === "storage"))
			) {
				if (
					((type === "focus" || type === "storage") && this !== window) ||
					(type === "visibilitychange" && this !== document)
				) {
					return fail("Unexpected shipping temporal listener target");
				}
				const capture = captureOf(options);
				if (
					!listeners.some(
						(record) =>
							record.target === this &&
							record.type === type &&
							record.handler === handler &&
							record.capture === capture
					)
				) {
					listeners.push({ target: this, type, handler, capture });
				}
			}
			return result;
		};
		EventTarget.prototype.removeEventListener = function (
			type,
			handler,
			options
		) {
			const result = Reflect.apply(originalRemove, this, [
				type,
				handler,
				options,
			]);
			const capture = captureOf(options);
			const index = listeners.findIndex(
				(record) =>
					record.target === this &&
					record.type === type &&
					record.handler === handler &&
					record.capture === capture
			);
			if (index >= 0) {
				listeners.splice(index, 1);
			}
			return result;
		};
		window.MutationObserver = class extends OriginalObserver {
			private readonly audited: boolean;
			constructor(callback: MutationCallback) {
				const owner = ownership();
				super(callback);
				this.audited = owner === "timezone";
			}
			override observe(target: Node, options?: MutationObserverInit): void {
				super.observe(target, options);
				if (this.audited) {
					observers.add(this);
				}
			}
			override disconnect(): void {
				super.disconnect();
				observers.delete(this);
			}
		};
		Object.defineProperty(window, "__timeConsumerResources", {
			value: () => ({
				timers: timers.size,
				focus: listeners.filter((record) => record.type === "focus").length,
				visibility: listeners.filter(
					(record) => record.type === "visibilitychange"
				).length,
				storage: listeners.filter((record) => record.type === "storage").length,
				timezoneObservers: observers.size,
				errors: [...errors],
			}),
		});
	}, consumerCallsites(directory));
}

export function consumerResources(page: Page): Promise<ConsumerResources> {
	return page.evaluate(() => {
		const read = Reflect.get(window, "__timeConsumerResources");
		if (typeof read !== "function") {
			throw new Error("Actual consumer resource audit is missing");
		}
		return read();
	});
}
