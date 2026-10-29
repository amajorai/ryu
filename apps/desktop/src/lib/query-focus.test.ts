import { expect, test } from "bun:test";
import { observeQueryFocus } from "./query-focus.ts";

interface FocusPageState {
	hasFocus: Document["hasFocus"];
	visibilityState: DocumentVisibilityState;
}

test("pauses on blur and hide, resumes on focus, and removes all listeners", () => {
	const changes: boolean[] = [];
	const target = new EventTarget();
	let focused = true;
	const pageState: FocusPageState = {
		visibilityState: "visible",
		hasFocus: () => focused,
	};
	const page = Object.assign(new EventTarget(), pageState);
	const stop = observeQueryFocus((value) => changes.push(value), target, page);
	target.dispatchEvent(new Event("blur"));
	target.dispatchEvent(new Event("focus"));
	page.visibilityState = "hidden";
	page.dispatchEvent(new Event("visibilitychange"));
	target.dispatchEvent(new Event("focus"));
	focused = false;
	page.visibilityState = "visible";
	page.dispatchEvent(new Event("visibilitychange"));
	focused = true;
	target.dispatchEvent(new Event("focus"));
	expect(changes).toEqual([true, false, true, false, false, false, true]);
	stop();
	target.dispatchEvent(new Event("blur"));
	page.dispatchEvent(new Event("visibilitychange"));
	expect(changes).toHaveLength(7);
});
