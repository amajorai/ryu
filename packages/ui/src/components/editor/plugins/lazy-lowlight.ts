// A lowlight stand-in whose grammars load on demand.
//
// `createLowlight(all)` pulls every highlight.js grammar (about 1.5 MB before
// minification) into whichever chunk imports the editor kit, and the chat
// composer imports it on the default route. Plate's code-block plugin only
// calls `highlight`, `highlightAuto`, `listLanguages`, `register` and
// `registerAlias`, and it already renders a block as plaintext when
// highlighting throws. This object answers those calls: before the grammars
// arrive it throws (so Plate falls back to plaintext) and queues registrations;
// afterwards it delegates to the real instance. Loading starts at idle time, or
// at the first highlight request, whichever comes first.

import type { createLowlight } from "lowlight";

type Lowlight = ReturnType<typeof createLowlight>;
type Register = Lowlight["register"];
type RegisterAlias = Lowlight["registerAlias"];

const NOT_READY = "Syntax highlighting is still loading.";

let real: Lowlight | null = null;
let loading: Promise<Lowlight> | null = null;
const pendingRegistrations: Array<(instance: Lowlight) => void> = [];

function loadLowlight(): Promise<Lowlight> {
	loading ??= import("lowlight")
		.then(({ all, createLowlight: create }) => {
			const instance = create(all);
			for (const apply of pendingRegistrations.splice(0)) {
				apply(instance);
			}
			real = instance;
			return instance;
		})
		.catch((error: unknown) => {
			loading = null;
			throw error;
		});
	return loading;
}

function requireLowlight(): Lowlight {
	if (real) {
		return real;
	}
	loadLowlight().catch(() => {
		// Highlighting stays plaintext; the next request retries the import.
	});
	throw new Error(NOT_READY);
}

/** Start fetching the grammars once the renderer is idle. */
export function preloadLowlight(): void {
	if (real || loading || typeof window === "undefined") {
		return;
	}
	const start = () => {
		loadLowlight().catch(() => {
			// Retried on the first highlight request.
		});
	};
	if (typeof window.requestIdleCallback === "function") {
		window.requestIdleCallback(start, { timeout: 5000 });
	} else {
		window.setTimeout(start, 2000);
	}
}

export const lazyLowlight = {
	highlight: (...args: Parameters<Lowlight["highlight"]>) =>
		requireLowlight().highlight(...args),
	highlightAuto: (...args: Parameters<Lowlight["highlightAuto"]>) =>
		requireLowlight().highlightAuto(...args),
	listLanguages: (): string[] => real?.listLanguages() ?? [],
	registered: (alias: string): boolean => real?.registered(alias) ?? false,
	register: ((...args: Parameters<Register>) => {
		if (real) {
			real.register(...args);
			return;
		}
		pendingRegistrations.push((instance) => instance.register(...args));
	}) as Register,
	registerAlias: ((...args: Parameters<RegisterAlias>) => {
		if (real) {
			real.registerAlias(...args);
			return;
		}
		pendingRegistrations.push((instance) => instance.registerAlias(...args));
	}) as RegisterAlias,
};
