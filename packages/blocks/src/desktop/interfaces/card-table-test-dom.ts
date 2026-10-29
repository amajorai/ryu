import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM for the Card Table tests before React loads (import this
 * first, for its side effect): React DOM decides whether it can use the
 * DOM when its module loads, and the ask card's dialog portal needs it.
 */
const registered = globalThis.document === undefined;
if (registered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registered && GlobalRegistrator.isRegistered) {
		await GlobalRegistrator.unregister();
	}
});

/**
 * Keeps a DOM for this test file. This module loads once per run, so its
 * own registration ends with the first Card Table file that imported it;
 * each file calls this after its imports, and a later file registers a DOM
 * of its own (removed again after that file).
 */
export function cardTableDom(): void {
	if (globalThis.document !== undefined) {
		return;
	}
	GlobalRegistrator.register();
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	afterAll(async () => {
		if (GlobalRegistrator.isRegistered) {
			await GlobalRegistrator.unregister();
		}
	});
}
