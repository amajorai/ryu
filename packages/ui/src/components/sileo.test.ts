import { beforeEach, describe, expect, test } from "bun:test";
import { sileo } from "sileo";
// Importing the wrapper is what installs the slot rules on the shared `sileo`
// singleton — the ~40 call sites that import "sileo" directly rely on exactly
// this side effect, so the test exercises the same entry point they do.
import { Toaster } from "./sileo.tsx";

const PROGRESS_ID = "ryu-toast-progress";

describe("sileo slot ids", () => {
	beforeEach(() => {
		sileo.clear();
	});

	test("shared toaster preserves sentence casing in titles", () => {
		const anchor = Toaster({ position: "bottom-center" });
		// The toaster is wrapped in an always-mounted aria-live anchor.
		const element = anchor.props.children;

		expect(anchor.props["data-slot"]).toBe("toaster");
		expect(element.props.position).toBe("bottom-center");
		expect(element.props.options.styles.title).toBe("ryu-sileo-title");
	});

	test("chained progress toasts share one slot", () => {
		const first = sileo.show({
			type: "loading",
			title: "Verifying captcha...",
			duration: null,
		});
		const second = sileo.show({
			type: "loading",
			title: "Signing in...",
			duration: null,
		});

		expect(first).toBe(PROGRESS_ID);
		expect(second).toBe(PROGRESS_ID);
	});

	test("a terminal toast takes over the live progress slot", () => {
		sileo.show({ type: "loading", title: "Signing in...", duration: null });

		// Replacing the never-expiring loading toast in place is what retires it:
		// the success toast carries a real duration, so the slot finally clears.
		expect(sileo.success({ title: "Sign in successful" })).toBe(PROGRESS_ID);
	});

	test("terminal toasts stack by content once no progress is pending", () => {
		const success = sileo.success({ title: "Saved" });
		const error = sileo.error({ title: "Nope" });

		expect(success).not.toBe(PROGRESS_ID);
		expect(error).not.toBe(PROGRESS_ID);
		expect(success).not.toBe(error);
		// Re-firing the same message reuses its slot instead of piling up.
		expect(sileo.success({ title: "Saved" })).toBe(success);
	});

	test("dismissing the progress slot releases it", () => {
		const loadingId = sileo.show({
			type: "loading",
			title: "Sending verification email...",
			duration: null,
		});
		sileo.dismiss(loadingId);

		// Nothing to take over, so the follow-up gets its own content slot and the
		// dismiss cannot race it away.
		expect(sileo.success({ title: "Verification email sent" })).not.toBe(
			PROGRESS_ID
		);
	});

	test("clear() releases the progress slot", () => {
		sileo.show({ type: "loading", title: "Working...", duration: null });
		sileo.clear();

		expect(sileo.error({ title: "Failed" })).not.toBe(PROGRESS_ID);
	});

	test("a caller-supplied id always wins", () => {
		expect(
			// SAFETY: This complete native Sileo options literal adds only id.
			// The installed createToast reads merged.id, and the shared wrapper
			// preserves explicit caller ids; its public options type omits id.
			sileo.show({
				id: "update-available",
				type: "loading",
				title: "Downloading update...",
				duration: null,
			} as Parameters<typeof sileo.show>[0])
		).toBe("update-available");
	});
});
