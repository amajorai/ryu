// Shared UI retry behavior is exercised here because this package owns the DOM
// interaction-test dependencies; the component remains the actual UI export.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectionPhase } from "@ryu/ui/components/connection-status.tsx";
import { MotionGlobalConfig } from "motion/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// happy-dom never completes motion's exit animation, so AnimatePresence would
// keep the leaving toast mounted forever. These cases cover retry and removal,
// not motion, so animations resolve instantly.
MotionGlobalConfig.skipAnimations = true;

const { ConnectionStatusToast } = await import(
	"@ryu/ui/components/connection-status.tsx"
);

let container: HTMLDivElement;
let root: Root;
const onRetry = mock(() => undefined);

beforeEach(() => {
	onRetry.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function render(phase: ConnectionPhase, retrying = false) {
	await act(async () => {
		root.render(
			<ConnectionStatusToast
				nodeName="Selected node"
				onRetry={onRetry}
				phase={phase}
				retrying={retrying}
			/>
		);
	});
}

function retryButton() {
	return container.querySelector<HTMLButtonElement>(
		'[data-slot="connection-status-retry"]'
	);
}

test("Retry calls the supplied node retry once and locks while a connection check is pending", async () => {
	await render("node-unreachable");
	expect(container.textContent).toContain("Can’t reach Selected node");
	const button = retryButton();
	expect(button).not.toBeNull();
	await act(async () => button?.click());
	expect(onRetry).toHaveBeenCalledTimes(1);

	await render("node-unreachable", true);
	expect(retryButton()?.disabled).toBe(true);
	expect(retryButton()?.getAttribute("aria-label")).toBe("Checking connection");
	await act(async () => retryButton()?.click());
	expect(onRetry).toHaveBeenCalledTimes(1);

	await render("node-unreachable", false);
	expect(retryButton()?.disabled).toBe(false);
	await act(async () => retryButton()?.click());
	expect(onRetry).toHaveBeenCalledTimes(2);
});

test("offline and reconnecting phases cannot trigger the node retry, and online removes the toast", async () => {
	for (const phase of ["offline", "checking"] as const) {
		await render(phase);
		expect(retryButton()).toBeNull();
		expect(container.querySelector('[role="status"]')).not.toBeNull();
	}
	await render("online");
	await act(async () => {
		for (let attempt = 0; attempt < 40 && container.textContent; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});
	expect(container.textContent).toBe("");
	expect(retryButton()).toBeNull();
	expect(onRetry).not.toHaveBeenCalled();
});

test("a node-unreachable toast without a retry handler never offers a dead action", async () => {
	await act(async () =>
		root.render(
			<ConnectionStatusToast
				nodeName="Selected node"
				phase="node-unreachable"
			/>
		)
	);
	expect(container.textContent).toContain("Reconnecting automatically");
	expect(retryButton()).toBeNull();
});
