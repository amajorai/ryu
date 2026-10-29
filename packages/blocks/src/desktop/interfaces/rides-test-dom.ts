import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Rides test DOM: imported first, so the DOM exists before any module
 * that reads it on import (the dialog primitives) loads. A file that
 * registered it unregisters it in its own `afterAll`.
 */
export const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
