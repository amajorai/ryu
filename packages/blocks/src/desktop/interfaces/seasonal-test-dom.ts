import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM for the Seasonal tests before React loads (import this
 * first, for its side effect): React DOM decides whether it can use the
 * DOM when its module loads, and the ask card's dialog portal needs it.
 *
 * Bun loads this module once per run, so a second Seasonal test file finds
 * it cached after the first file's `afterAll` took the DOM down: each file
 * also calls `seasonalDom()` at its top, which registers the DOM again when
 * it is missing and takes it down after that file.
 */
export function seasonalDom(): void {
	if (globalThis.document !== undefined) {
		return;
	}
	GlobalRegistrator.register();
	afterAll(async () => {
		if (GlobalRegistrator.isRegistered) {
			await GlobalRegistrator.unregister();
		}
	});
}

seasonalDom();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
