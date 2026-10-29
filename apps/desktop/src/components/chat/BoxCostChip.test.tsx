import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseSessionBoxView } from "@/src/lib/api/session-box.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const {
	BoxCostChip,
	BoxCreditBanner,
	boxCostLabel,
	formatBoxCost,
	formatBoxRunningTime,
} = await import("./BoxCostChip.tsx");

const roots: Root[] = [];

function box(overrides: Record<string, unknown> = {}) {
	const view = parseSessionBoxView({
		id: "box-1",
		size: "small",
		state: "ready",
		runningSeconds: 1080,
		accruedMicroUsd: 12_300,
		ratePerHourMicroUsd: 41_000,
		warning: "none",
		...overrides,
	});
	if (!view) {
		throw new Error("fixture did not parse");
	}
	return view;
}

async function render(element: React.ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	return container;
}

beforeEach(() => {
	useSettingsDialog.setState({ open: false, section: "general" });
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

test("formats cost and running time", () => {
	expect(formatBoxCost(12_300)).toBe("$0.0123");
	expect(formatBoxCost(0)).toBe("$0.0000");
	expect(formatBoxCost(1_234_567)).toBe("$1.23");
	expect(formatBoxCost(-5)).toBe("$0.0000");
	expect(formatBoxRunningTime(30)).toBe("<1 min");
	expect(formatBoxRunningTime(1080)).toBe("18 min");
	expect(formatBoxRunningTime(3900)).toBe("1 h 05 min");
});

test("the chip shows cost and time, and its tooltip the Gateway's rate", async () => {
	const container = await render(<BoxCostChip box={box()} />);
	const chip = container.querySelector('[data-testid="box-cost-chip"]');
	expect(chip?.textContent).toBe("$0.0123 · 18 min");
	expect(chip?.getAttribute("title")).toContain("Rate: $0.0410 per hour");
	expect(chip?.getAttribute("data-box-warning")).toBe("none");
});

test("the chip renders nothing before Core has metered the Box", async () => {
	const container = await render(
		<BoxCostChip box={box({ runningSeconds: null, accruedMicroUsd: null })} />
	);
	expect(container.textContent).toBe("");
});

test("a running Box reads starting until the Gateway's first tick accrues a cost", async () => {
	// Core reports 0 for a run that has not been ticked yet.
	const container = await render(
		<BoxCostChip box={box({ runningSeconds: 20, accruedMicroUsd: 0 })} />
	);
	const chip = container.querySelector('[data-testid="box-cost-chip"]');
	expect(chip?.textContent).toBe("starting");
	expect(chip?.hasAttribute("data-box-pending")).toBe(true);
	expect(container.textContent).not.toContain("$0.0000");
});

test("a provisioning Box with no cost field yet also reads starting", async () => {
	const container = await render(
		<BoxCostChip
			box={box({
				state: "provisioning",
				runningSeconds: 0,
				accruedMicroUsd: null,
			})}
		/>
	);
	expect(container.textContent).toBe("starting");
});

test("the first accrual replaces starting with the cost", async () => {
	const container = await render(
		<BoxCostChip box={box({ runningSeconds: 20, accruedMicroUsd: 0 })} />
	);
	expect(container.textContent).toBe("starting");
	const root = roots.at(-1);
	await act(async () =>
		root?.render(
			<BoxCostChip box={box({ runningSeconds: 75, accruedMicroUsd: 683 })} />
		)
	);
	const chip = container.querySelector('[data-testid="box-cost-chip"]');
	expect(chip?.textContent).toBe("$0.0007 · 1 min");
	expect(chip?.hasAttribute("data-box-pending")).toBe(false);
});

test("a parked Box with nothing accrued shows no chip", async () => {
	expect(
		boxCostLabel(
			box({ state: "parked", runningSeconds: 0, accruedMicroUsd: 0 })
		)
	).toBe(null);
	const container = await render(
		<BoxCostChip
			box={box({ state: "parked", runningSeconds: 0, accruedMicroUsd: 0 })}
		/>
	);
	expect(container.textContent).toBe("");
});

test("a low warning renders a status with Top up", async () => {
	const container = await render(
		<BoxCreditBanner box={box({ warning: "low", minutesRemaining: 12 })} />
	);
	const banner = container.querySelector('[data-testid="box-credit-banner"]');
	expect(banner?.getAttribute("role")).toBe("status");
	expect(banner?.textContent).toContain("about 12 min of Box time left");
	expect(banner?.textContent).toContain("Top up");
});

test("a critical warning renders an alert", async () => {
	const container = await render(
		<BoxCreditBanner box={box({ warning: "critical", minutesRemaining: 3 })} />
	);
	const banner = container.querySelector('[data-testid="box-credit-banner"]');
	expect(banner?.getAttribute("role")).toBe("alert");
	expect(banner?.textContent).toContain("Credits are almost out");
});

test("no warning renders no banner", async () => {
	const container = await render(<BoxCreditBanner box={box()} />);
	expect(container.querySelector('[data-testid="box-credit-banner"]')).toBe(
		null
	);
});

test("the exhaustion banner's Top up opens the credit settings", async () => {
	const container = await render(
		<BoxCreditBanner
			box={box({ state: "parked", stopReason: "balance", warning: "critical" })}
		/>
	);
	expect(container.textContent).toContain("your credits ran out");
	const topUp = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Top up"
	);
	expect(topUp).toBeDefined();
	await act(async () => topUp?.click());
	expect(useSettingsDialog.getState().open).toBe(true);
	expect(useSettingsDialog.getState().section).toBe("credits");
});

test("a budget stop explains itself without offering a top-up", async () => {
	const container = await render(
		<BoxCreditBanner box={box({ state: "parked", stopReason: "budget" })} />
	);
	expect(container.textContent).toContain("spending budget");
	expect(container.textContent).not.toContain("Top up");
});

test("an idle park is not a credit problem", async () => {
	const container = await render(
		<BoxCreditBanner box={box({ state: "parked", stopReason: "idle" })} />
	);
	expect(container.textContent).toBe("");
});
