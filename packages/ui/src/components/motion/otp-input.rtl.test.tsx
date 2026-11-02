import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { OTPCodeDisplay, OTPInput } = await import("./otp-input.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountInRtl(node: ReactNode) {
	const host = document.createElement("div");
	host.setAttribute("dir", "rtl");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
		await Promise.resolve();
	});
	return {
		host,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

function slotRow(host: HTMLElement): HTMLElement {
	const row =
		host.querySelector<HTMLElement>("[data-otp-index]")?.parentElement;
	if (!row) {
		throw new Error("OTP slot row did not render");
	}
	return row;
}

function activeIndex(host: HTMLElement): number {
	const ring = host.querySelector<HTMLElement>(
		"[data-otp-index][data-active='true']"
	);
	return ring ? Number(ring.dataset.otpIndex) : -1;
}

function press(target: HTMLElement, key: string) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

describe("OTPInput inside a right-to-left layout", () => {
	test("the fieldset and slot row resolve to LTR while slots keep their order", async () => {
		const { host, unmount } = await mountInRtl(
			<OTPInput defaultValue="123456" label="Code" />
		);
		try {
			const fieldset = host.querySelector("fieldset");
			expect(fieldset?.getAttribute("dir")).toBe("ltr");
			const row = slotRow(host);
			expect(row.getAttribute("dir")).toBe("ltr");
			expect(row.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
			const order = [
				...row.querySelectorAll<HTMLElement>("[data-otp-index]"),
			].map((slot) => slot.dataset.otpIndex);
			expect(order).toEqual(["0", "1", "2", "3", "4", "5"]);
			// The label stays in the inherited (RTL) direction.
			const label = host.querySelector("label");
			expect(label?.closest("[dir]")?.getAttribute("dir")).toBe("rtl");
		} finally {
			unmount();
		}
	});

	test("ArrowRight advances to the next slot", async () => {
		const { host, unmount } = await mountInRtl(<OTPInput defaultValue="12" />);
		try {
			const input = host.querySelector<HTMLInputElement>("input");
			if (!input) {
				throw new Error("OTP input did not render");
			}
			act(() => {
				input.focus();
			});
			press(input, "Home");
			const start = activeIndex(host);
			press(input, "ArrowRight");
			expect(start).toBe(0);
			expect(activeIndex(host)).toBe(1);
		} finally {
			unmount();
		}
	});
});

test("OTPCodeDisplay reads a grouped code left-to-right under RTL", () => {
	const markup = renderToStaticMarkup(
		<div dir="rtl">
			<OTPCodeDisplay code="ABCD-EFGH" />
		</div>
	);
	expect(markup).toContain(
		'<fieldset class="relative m-0 inline-flex w-max border-0 p-0" dir="ltr">'
	);
	const chars = [...markup.matchAll(/data-otp-index="(\d+)"/g)].map(
		(match) => match[1]
	);
	expect(chars).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	expect(markup).toContain('value="ABCDEFGH"');
	expect(markup.match(/dir="ltr"/g)).toHaveLength(2);
});
