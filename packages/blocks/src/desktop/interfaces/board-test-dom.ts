// Registers happy-dom before React and Base UI load, so portalled popups
// (Display, Filter, the command menu) mount in Board tests.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export const registeredBoardDom = globalThis.document === undefined;
if (registeredBoardDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Base UI waits on animations, which happy-dom does not model.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
