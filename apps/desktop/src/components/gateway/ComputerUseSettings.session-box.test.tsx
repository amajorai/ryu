import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let boxBackendFlag = true;
let stored: string | null = null;
const writes: { key: string; value: string }[] = [];
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => boxBackendFlag,
}));
mock.module("@/src/lib/api/preferences.ts", () => ({
	getPreference: () => Promise.resolve(stored),
	setPreference: (_target: unknown, key: string, value: string) => {
		writes.push({ key, value });
		stored = value;
		return Promise.resolve(true);
	},
}));
mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayConfig: () =>
		Promise.resolve({ computer_use: { locked_use: false } }),
	updateGatewayConfig: () => Promise.resolve(),
}));
let costState: {
	acknowledged: boolean;
	acknowledgedAt: string | null;
	minimumSecondsPerStart: number;
	ratePerHourMicroUsd: number | null;
	size: "small" | null;
} | null = null;
const acknowledgements: number[] = [];
mock.module("@/src/lib/api/session-box.ts", () => ({
	fetchSessionBoxCostNoticeState: () => Promise.resolve(costState),
	acknowledgeSessionBoxCostAhead: (_target: unknown, rate: number) => {
		acknowledgements.push(rate);
		if (costState) {
			costState = {
				...costState,
				acknowledged: true,
				acknowledgedAt: "2026-10-20T10:00:00Z",
			};
		}
		return Promise.resolve();
	},
	sessionBoxErrorMessage: (error: unknown) =>
		error instanceof Error ? error.message : "failed",
}));
const { createRoot } = await import("react-dom/client");
const {
	ComputerUseSettings,
	parseSessionBoxComputerTarget,
	SESSION_BOX_COMPUTER_TARGET_PREF,
} = await import("./ComputerUseSettings.tsx");

const roots: Root[] = [];
const LABEL = "Where computer use runs in a conversation";

beforeEach(() => {
	boxBackendFlag = true;
	stored = null;
	writes.length = 0;
	costState = null;
	acknowledgements.length = 0;
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

async function render(canConfigure = true): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<ComputerUseSettings
				canConfigure={canConfigure}
				reachable
				target={{ url: "http://node.test:7980", token: null }}
			/>
		);
		await Bun.sleep(10);
	});
	return container;
}

function targetSelect(container: HTMLElement): HTMLSelectElement | null {
	return container.querySelector<HTMLSelectElement>(
		`select[aria-label="${LABEL}"]`
	);
}

test("parses the preference the way Core does", () => {
	expect(parseSessionBoxComputerTarget(null)).toBe("auto");
	expect(parseSessionBoxComputerTarget("auto")).toBe("auto");
	expect(parseSessionBoxComputerTarget(" NODE ")).toBe("node");
	expect(parseSessionBoxComputerTarget("anything")).toBe("auto");
});

test("an unset preference shows the default: the session's own Box", async () => {
	const container = await render();
	const select = targetSelect(container);
	expect(select?.value).toBe("auto");
	expect(select?.disabled).toBe(false);
});

test("choosing this device writes the node preference to Core", async () => {
	const container = await render();
	const select = targetSelect(container);
	await act(async () => {
		if (select) {
			select.value = "node";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await Bun.sleep(5);
	});
	expect(writes).toEqual([
		{ key: SESSION_BOX_COMPUTER_TARGET_PREF, value: "node" },
	]);
	expect(targetSelect(container)?.value).toBe("node");
});

test("a stored node preference is shown", async () => {
	stored = "node";
	const container = await render();
	expect(targetSelect(container)?.value).toBe("node");
});

test("without configuration access the control is read-only", async () => {
	const container = await render(false);
	expect(targetSelect(container)?.disabled).toBe(true);
});

test("with the Box rollout off the control is hidden", async () => {
	boxBackendFlag = false;
	const container = await render();
	expect(targetSelect(container)).toBeNull();
});

test("the Box cost can be allowed ahead of any conversation", async () => {
	costState = {
		acknowledged: false,
		acknowledgedAt: null,
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: 25_000,
		size: "small",
	};
	const container = await render();
	const notice = container.querySelector(
		'[data-testid="computer-use-cost-notice"]'
	);
	expect(notice?.textContent).toContain("$0.025/hour");
	expect(notice?.textContent).toContain("5-minute minimum per start");
	const allow = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Allow"
	);
	await act(async () => {
		allow?.click();
		await Bun.sleep(5);
	});
	expect(acknowledgements).toEqual([25_000]);
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice"]')
	).toBeNull();
	expect(container.textContent).toContain("Session Box cost");
	expect(container.textContent).toContain(
		"Session Boxes start without asking, including in routines"
	);
});

test("the Box cost row is hidden for this device's computer use or an older Core", async () => {
	stored = "node";
	costState = {
		acknowledged: false,
		acknowledgedAt: null,
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: 25_000,
		size: "small",
	};
	let container = await render();
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice"]')
	).toBeNull();
	stored = null;
	costState = null;
	container = await render();
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice"]')
	).toBeNull();
	expect(container.textContent).not.toContain("Session Box cost");
});
