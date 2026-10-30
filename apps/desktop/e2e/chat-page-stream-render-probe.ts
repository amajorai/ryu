// Browser-side probe for the ChatPage streaming render budget. Installed with
// `page.addInitScript` before any app module loads, it does two things:
//
// 1. Counts which named components React actually rendered in each commit,
//    through the same `__REACT_DEVTOOLS_GLOBAL_HOOK__` seam React DevTools uses
//    (a fiber rendered when it carries the PerformedWork flag and its parent's
//    children were reconciled in that commit).
// 2. Serves the next `/api/chat/stream` request from an in-page SSE stream the
//    spec drives chunk by chunk, so chunk timing is deterministic. Every other
//    request still reaches the owned Core fixture.

export interface StreamRenderProbe {
	arm(): void;
	close(): void;
	commits(): number;
	counts(): Record<string, number>;
	/** With "*" watched: the first rendered names of each commit, top-down. */
	log(): string[][];
	opened(): boolean;
	push(chunks: unknown[]): void;
	reset(): void;
	streamChunks(count: number, intervalMs: number): Promise<void>;
}

/** Runs in the page before the app. Self-contained: no closure over Node scope. */
export function installStreamRenderProbe(watched: string[]) {
	const PERFORMED_WORK = 1;
	const watch = new Set(watched);
	let counts: Record<string, number> = {};
	let commits = 0;
	let commitLog: string[][] = [];
	let commitNames: string[] = [];
	const nameOf = (type: unknown): string | null => {
		if (typeof type === "function") {
			const named = type as { displayName?: string; name?: string };
			return named.displayName || named.name || null;
		}
		if (type && typeof type === "object" && "render" in type) {
			return nameOf((type as { render: unknown }).render);
		}
		return null;
	};
	interface ProbeFiber {
		alternate: ProbeFiber | null;
		child: ProbeFiber | null;
		flags: number;
		sibling: ProbeFiber | null;
		type: unknown;
	}
	const record = (fiber: ProbeFiber) => {
		// The dev bundler renames an inner `memo(function Name…)` to `Name2`.
		const name = nameOf(fiber.type)?.replace(/\d+$/, "");
		if (name && (watch.has(name) || watch.has("*"))) {
			counts[name] = (counts[name] ?? 0) + 1;
			if (watch.has("*") && commitNames.length < 12) {
				commitNames.push(name);
			}
		}
	};
	const mount = (first: ProbeFiber | null) => {
		for (let fiber = first; fiber; fiber = fiber.sibling) {
			record(fiber);
			mount(fiber.child);
		}
	};
	const update = (next: ProbeFiber, prev: ProbeFiber) => {
		// Only the fibers this commit reconciled; an untouched subtree keeps its
		// child pointer and the flags of whatever commit last rendered it.
		if (next.child === prev.child) {
			return;
		}
		for (let child = next.child; child; child = child.sibling) {
			if (child.alternate) {
				if (child.flags & PERFORMED_WORK) {
					record(child);
				}
				update(child, child.alternate);
			} else {
				mount(child);
			}
		}
	};
	const hook = {
		renderers: new Map(),
		supportsFiber: true,
		inject: (renderer: unknown) => {
			hook.renderers.set(1, renderer);
			return 1;
		},
		onCommitFiberRoot: (
			_id: number,
			root: { current: ProbeFiber & { alternate: ProbeFiber | null } }
		) => {
			commits += 1;
			commitNames = [];
			const current = root.current;
			if (current.alternate) {
				update(current, current.alternate);
			} else {
				mount(current.child);
			}
			if (watch.has("*")) {
				commitLog.push(commitNames);
			}
		},
		onCommitFiberUnmount: () => undefined,
		onPostCommitFiberRoot: () => undefined,
		checkDCE: () => undefined,
	};
	Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", hook);

	const encoder = new TextEncoder();
	let armed = false;
	let opened = false;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const push = (chunks: unknown[]) => {
		controller?.enqueue(
			encoder.encode(
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
			)
		);
	};
	const originalFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (
			!(armed && new URL(url, location.href).pathname === "/api/chat/stream")
		) {
			return originalFetch(input, init);
		}
		armed = false;
		opened = true;
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		return Promise.resolve(
			new Response(body, {
				headers: {
					"content-type": "text/event-stream",
					"x-vercel-ai-ui-message-stream": "v1",
				},
			})
		);
	};
	const probe: StreamRenderProbe = {
		arm: () => {
			armed = true;
		},
		close: () => {
			push([
				{ type: "text-end", id: "probe-text" },
				{ type: "finish", finishReason: "stop" },
			]);
			controller?.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller?.close();
			controller = null;
		},
		commits: () => commits,
		counts: () => ({ ...counts }),
		log: () => commitLog.slice(0, 40),
		opened: () => opened,
		push,
		reset: () => {
			counts = {};
			commits = 0;
			commitLog = [];
		},
		streamChunks: async (count, intervalMs) => {
			for (let index = 1; index <= count; index += 1) {
				push([
					{ type: "text-delta", id: "probe-text", delta: ` chunk-${index}` },
				]);
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
		},
	};
	Reflect.set(window, "__streamRenderProbe", probe);
}
