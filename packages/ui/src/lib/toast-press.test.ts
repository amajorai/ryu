// Unit tests for cancelToastDismissal: a press on a toast must never dismiss
// the open dialog, and every other dismissal must pass through untouched.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register();
}

import { afterAll, describe, expect, test } from "bun:test";
import { cancelToastDismissal, TOASTER_SLOT } from "./toast-press.ts";

// Release the DOM globals this file installed: sibling files in the same
// `bun test src` process register their own and fail if one is left behind.
afterAll(async () => {
	if (registeredHere && GlobalRegistrator.isRegistered) {
		await GlobalRegistrator.unregister();
	}
});

function pressOn(target: Element, reason = "outside-press") {
	const event = new Event("pointerdown");
	Object.defineProperty(event, "target", { value: target });
	let cancelled = false;
	return {
		details: {
			cancel: () => {
				cancelled = true;
			},
			event,
			reason,
		},
		wasCancelled: () => cancelled,
	};
}

function toastButton() {
	const anchor = document.createElement("div");
	anchor.dataset.slot = TOASTER_SLOT;
	const button = document.createElement("button");
	anchor.append(button);
	return button;
}

describe("cancelToastDismissal", () => {
	test("cancels an outside press that started on a toast", () => {
		const press = pressOn(toastButton());
		expect(cancelToastDismissal(false, press.details)).toBe(true);
		expect(press.wasCancelled()).toBe(true);
	});

	test("lets an outside press elsewhere dismiss", () => {
		const press = pressOn(document.createElement("button"));
		expect(cancelToastDismissal(false, press.details)).toBe(false);
		expect(press.wasCancelled()).toBe(false);
	});

	test("never touches other reasons or an opening change", () => {
		const escapeKey = pressOn(toastButton(), "escape-key");
		expect(cancelToastDismissal(false, escapeKey.details)).toBe(false);
		const opening = pressOn(toastButton());
		expect(cancelToastDismissal(true, opening.details)).toBe(false);
		expect(escapeKey.wasCancelled() || opening.wasCancelled()).toBe(false);
	});
});
