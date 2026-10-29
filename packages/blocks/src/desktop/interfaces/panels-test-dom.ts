/**
 * Test-only: registers happy-dom before React DOM and Base UI load. They read
 * the environment once at import; registered later, the Chat switcher's menu
 * never opens under test.
 * Imported for its side effect, first, by panels-interface.test.tsx.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Set on globalThis when this module registered the DOM, so the test unregisters it. */
export const PANELS_DOM_FLAG = "__panelsRegisteredDom";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
	Reflect.set(globalThis, PANELS_DOM_FLAG, true);
}
