/**
 * Test-only: registers happy-dom before React DOM and Base UI load. They read
 * the environment once at import; registered later, the persona switcher's
 * menu never opens under test and React's input tracking misfires.
 * Imported for its side effect, first, by persona-interface.test.tsx.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Set on globalThis when this module registered the DOM, so the test unregisters it. */
export const PERSONA_DOM_FLAG = "__personaRegisteredDom";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
	Reflect.set(globalThis, PERSONA_DOM_FLAG, true);
}
