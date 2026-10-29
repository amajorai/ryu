import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { World2dInterface } from "./world-2d-interface.tsx";

const AGENT_COUNT = 25;

const SNAPSHOT: InterfaceSnapshot = {
	agents: Array.from({ length: AGENT_COUNT }, (_, index) => ({
		avatarUrl: null,
		description: `Helper number ${index + 1}`,
		id: `agent-${index + 1}`,
		name: `Villager ${index + 1}`,
		status: index % 4 === 0 ? ("working" as const) : ("idle" as const),
	})),
	groups: [],
	threads: [],
	version: 1,
};

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	// Let React's scheduler drain its queued tasks while the DOM still exists.
	await new Promise((resolve) => setTimeout(resolve, 0));
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

function slotNames(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll<HTMLButtonElement>(
			'nav[aria-label="Villagers"] li button'
		),
	].map((button) => button.getAttribute("aria-label") ?? "");
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(element) => element.getAttribute("aria-label") === name
	);
	if (!match) {
		throw new Error(`No button labeled ${name}`);
	}
	return match;
}

async function press(target: HTMLElement, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

describe("World2dInterface hotbar pages", () => {
	test("shows a page of villagers that the arrows and [ ] keys turn", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<World2dInterface
					activeThreadId={null}
					loading={false}
					params={{ theme: "meadow" }}
					port={NOOP_PORT}
					snapshot={SNAPSHOT}
					threadView={null}
				/>
			)
		);
		try {
			// As many slots as fit, ten at most and never fewer than four (the
			// test DOM measures the view as zero wide).
			const firstPage = slotNames(container);
			const pageSize = firstPage.length;
			expect(pageSize).toBeGreaterThanOrEqual(4);
			expect(pageSize).toBeLessThanOrEqual(10);
			const pages = Math.ceil(AGENT_COUNT / pageSize);
			expect(container.textContent).toContain(`Page 1 of ${pages}`);
			// The controls and map slots stay outside the paged list.
			expect(button(container, "Controls")).toBeTruthy();
			expect(button(container, "Village map")).toBeTruthy();
			expect(button(container, "Previous villagers").disabled).toBe(true);

			const seen = new Set(firstPage);
			await act(async () => button(container, "Next villagers").click());
			expect(container.textContent).toContain(`Page 2 of ${pages}`);
			for (const name of slotNames(container)) {
				expect(seen.has(name)).toBe(false);
				seen.add(name);
			}

			const map = container.querySelector<HTMLElement>('[role="application"]');
			if (!map) {
				throw new Error("Expected the world map");
			}
			for (let page = 3; page <= pages; page++) {
				await press(map, "]");
				expect(container.textContent).toContain(`Page ${page} of ${pages}`);
				for (const name of slotNames(container)) {
					seen.add(name);
				}
			}
			// Every villager has a slot on some page.
			expect(seen.size).toBe(AGENT_COUNT);
			expect(button(container, "Next villagers").disabled).toBe(true);

			for (let page = 1; page < pages; page++) {
				await press(map, "[");
			}
			expect(slotNames(container)).toEqual(firstPage);
			expect(button(container, "Previous villagers").disabled).toBe(true);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
