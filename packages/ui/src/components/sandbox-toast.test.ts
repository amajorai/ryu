import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { normalizeSandboxToast, sandboxToast } from "./sandbox-toast.ts";

describe("sandbox toast", () => {
	test("normalizes string and options call shapes", () => {
		expect(normalizeSandboxToast("Saved")).toEqual({ title: "Saved" });
		expect(
			normalizeSandboxToast("Saved", {
				description: "All done",
				duration: 1000,
			})
		).toEqual({ description: "All done", duration: 1000, title: "Saved" });
		expect(
			normalizeSandboxToast({ title: "Saved", description: "All done" })
		).toEqual({
			description: "All done",
			title: "Saved",
		});
	});

	test("is safe to call in a non-DOM test or standalone process", () => {
		expect(() => sandboxToast.success("Saved")).not.toThrow();
		expect(() => sandboxToast.error({ title: "Failed" })).not.toThrow();
	});
});

describe("sandbox toast in a right-to-left frame", () => {
	const ARABIC_NOTIFICATIONS = "الإشعارات";
	const arabic = {
		direction: "rtl" as const,
		locale: "ar",
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			const source = fallback ?? id;
			return source === "Notifications"
				? ARABIC_NOTIFICATIONS
				: formatMessage(source, values, "ar");
		},
	};

	beforeAll(() => GlobalRegistrator.register());
	afterAll(() => GlobalRegistrator.unregister());
	afterEach(() => {
		unregisterActiveI18nRuntime(arabic);
		document.body.replaceChildren();
		document.documentElement.removeAttribute("dir");
	});

	function styleOf(element: Element | null): string {
		return element?.getAttribute("style") ?? "";
	}

	test("places the stack and the accent stripe with logical properties", () => {
		document.documentElement.dir = "rtl";
		sandboxToast.warning({ duration: 0, title: "Low disk space" });

		const container = document.getElementById("ryu-sandbox-toast-container");
		const toast = document.querySelector('[data-ryu-toast="warning"]');
		expect(toast?.textContent).toBe("Low disk space");

		const containerStyle = styleOf(container);
		expect(containerStyle).toContain("inset-inline-end");
		expect(containerStyle).not.toMatch(/(?:^|;)\s*(?:left|right)\s*:/);

		const toastStyle = styleOf(toast);
		expect(toastStyle).toContain("border-inline-start");
		expect(toastStyle).not.toMatch(/border-(?:left|right)\s*:/);
	});

	test("labels the stack in the active language", () => {
		sandboxToast.info({ duration: 0, title: "First" });
		const container = document.getElementById("ryu-sandbox-toast-container");
		expect(container?.getAttribute("aria-label")).toBe("Notifications");

		registerActiveI18nRuntime(arabic);
		sandboxToast.info({ duration: 0, title: "Second" });
		expect(container?.getAttribute("aria-label")).toBe(ARABIC_NOTIFICATIONS);
	});
});
