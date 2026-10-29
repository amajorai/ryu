import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers a DOM for the Passport tests before React loads (import this
 * first, for its side effect): React DOM decides whether it can use the
 * DOM when its module loads, and the ask card's dialog portal needs it.
 */
const registered = globalThis.document === undefined;
if (registered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registered) {
		await GlobalRegistrator.unregister();
	}
});
