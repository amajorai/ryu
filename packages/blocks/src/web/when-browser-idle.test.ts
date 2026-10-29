import { afterEach, expect, mock, test } from "bun:test";
import { whenBrowserIdle } from "./when-browser-idle.ts";

type Listener = () => void;

const originalWindow = Reflect.get(globalThis, "window");
const originalDocument = Reflect.get(globalThis, "document");
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
	Reflect.set(globalThis, "window", originalWindow);
	Reflect.set(globalThis, "document", originalDocument);
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
});

/** A minimal browser global with manual control of idle, frame and load. */
function installBrowser(options: {
	idle: boolean;
	readyState: DocumentReadyState;
}) {
	const idleCallbacks = new Map<number, Listener>();
	const frames = new Map<number, Listener>();
	const loadListeners = new Set<Listener>();
	const timers = new Map<number, { callback: Listener; delay: number }>();
	let nextHandle = 1;
	const fakeWindow = {
		addEventListener: mock((type: string, listener: Listener) => {
			if (type === "load") {
				loadListeners.add(listener);
			}
		}),
		cancelAnimationFrame: mock((handle: number) => frames.delete(handle)),
		cancelIdleCallback: mock((handle: number) => idleCallbacks.delete(handle)),
		removeEventListener: mock((type: string, listener: Listener) => {
			if (type === "load") {
				loadListeners.delete(listener);
			}
		}),
		requestAnimationFrame: mock((callback: Listener) => {
			const handle = nextHandle++;
			frames.set(handle, callback);
			return handle;
		}),
		requestIdleCallback: options.idle
			? mock((callback: Listener, _options?: { timeout: number }) => {
					const handle = nextHandle++;
					idleCallbacks.set(handle, callback);
					return handle;
				})
			: undefined,
	};
	Reflect.set(globalThis, "window", fakeWindow);
	Reflect.set(globalThis, "document", { readyState: options.readyState });
	globalThis.setTimeout = ((callback: Listener, delay: number) => {
		const handle = nextHandle++;
		timers.set(handle, { callback, delay });
		return handle;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((handle: number) => {
		timers.delete(handle);
	}) as typeof clearTimeout;
	const drain = (queue: Map<number, Listener> | Set<Listener>) => {
		const callbacks = [...queue.values()];
		queue.clear();
		for (const callback of callbacks) {
			callback();
		}
	};
	return {
		fakeWindow,
		frames,
		idleCallbacks,
		loadListeners,
		runFrames: () => drain(frames),
		runIdle: () => drain(idleCallbacks),
		runLoad: () => drain(loadListeners),
		runTimers: () => {
			const pending = [...timers.values()];
			timers.clear();
			for (const timer of pending) {
				timer.callback();
			}
		},
		timers,
	};
}

test("runs the task when the browser reports idle time", () => {
	const browser = installBrowser({ idle: true, readyState: "loading" });
	const task = mock(() => undefined);
	whenBrowserIdle(task, 1500);
	expect(task).not.toHaveBeenCalled();
	expect(browser.fakeWindow.requestIdleCallback?.mock.calls[0]?.[1]).toEqual({
		timeout: 1500,
	});
	browser.runIdle();
	expect(task).toHaveBeenCalledTimes(1);
});

test("cancelling before idle drops the task", () => {
	const browser = installBrowser({ idle: true, readyState: "complete" });
	const task = mock(() => undefined);
	const cancel = whenBrowserIdle(task);
	cancel();
	expect(browser.fakeWindow.cancelIdleCallback).toHaveBeenCalledTimes(1);
	browser.runIdle();
	expect(task).not.toHaveBeenCalled();
});

test("without idle callbacks an already-loaded page runs on the next frame", () => {
	const browser = installBrowser({ idle: false, readyState: "complete" });
	const task = mock(() => undefined);
	whenBrowserIdle(task);
	expect(browser.frames.size).toBe(1);
	browser.runFrames();
	expect(task).toHaveBeenCalledTimes(1);
});

test("without idle callbacks a loading page waits for load, then a frame", () => {
	const browser = installBrowser({ idle: false, readyState: "loading" });
	const task = mock(() => undefined);
	const cancel = whenBrowserIdle(task);
	expect(browser.frames.size).toBe(0);
	browser.runLoad();
	browser.runFrames();
	expect(task).toHaveBeenCalledTimes(1);
	cancel();
});

test("cancelling a pending load wait removes the listener and the cap", () => {
	const browser = installBrowser({ idle: false, readyState: "interactive" });
	const task = mock(() => undefined);
	const cancel = whenBrowserIdle(task);
	cancel();
	expect(browser.loadListeners.size).toBe(0);
	expect(browser.timers.size).toBe(0);
	browser.runFrames();
	browser.runTimers();
	expect(task).not.toHaveBeenCalled();
});

test("without idle callbacks timeoutMs caps a load that never fires", () => {
	const browser = installBrowser({ idle: false, readyState: "loading" });
	const task = mock(() => undefined);
	whenBrowserIdle(task, 1500);
	expect([...browser.timers.values()][0]?.delay).toBe(1500);
	browser.runTimers();
	expect(task).toHaveBeenCalledTimes(1);
	expect(browser.loadListeners.size).toBe(0);
	browser.runLoad();
	browser.runFrames();
	expect(task).toHaveBeenCalledTimes(1);
});

test("without idle callbacks the post-load frame clears the cap", () => {
	const browser = installBrowser({ idle: false, readyState: "loading" });
	const task = mock(() => undefined);
	whenBrowserIdle(task);
	browser.runLoad();
	browser.runFrames();
	expect(task).toHaveBeenCalledTimes(1);
	expect(browser.timers.size).toBe(0);
});

test("without idle callbacks the cap clears a pending post-load frame", () => {
	const browser = installBrowser({ idle: false, readyState: "complete" });
	const task = mock(() => undefined);
	whenBrowserIdle(task);
	browser.runTimers();
	expect(task).toHaveBeenCalledTimes(1);
	expect(browser.frames.size).toBe(0);
});

test("on the server it schedules nothing", () => {
	Reflect.set(globalThis, "window", undefined);
	const task = mock(() => undefined);
	const cancel = whenBrowserIdle(task);
	cancel();
	expect(task).not.toHaveBeenCalled();
});
