import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM for the Planets tests before React loads (import this
 * first, for its side effect): React DOM decides whether it can use the
 * DOM when its module loads, and the ask card's dialog portal needs it.
 *
 * Bun loads this module once per run, so a second Planets test file finds
 * it cached after the first file's `afterAll` took the DOM down: each file
 * also calls `planetsDom()` at its top, which registers the DOM again when
 * it is missing and takes it down after that file.
 */
export function planetsDom(): void {
	if (globalThis.document === undefined) {
		GlobalRegistrator.register();
		afterAll(async () => {
			if (GlobalRegistrator.isRegistered) {
				await GlobalRegistrator.unregister();
			}
		});
	}
	// happy-dom has no Web Animations; the panel's scroll area asks for them.
	if (!("getAnimations" in Element.prototype)) {
		Reflect.set(Element.prototype, "getAnimations", () => []);
	}
}

planetsDom();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
