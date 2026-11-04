import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * Stepping to the next module slides the new focus card in from the inline
 * end: from the physical right in English, from the physical left in Arabic.
 */

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { MomentsFlowView } = await import("./moments-flow.tsx");
type FlowProps = Parameters<typeof MomentsFlowView>[0];

function thread(id: string): InterfaceThread {
	return {
		agentIds: [],
		id,
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 1,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: id,
		updatedAt: "2026-10-12T12:00:00Z",
	};
}

const FLOW: NonNullable<FlowProps["flow"]> = {
	agents: [],
	id: "flow",
	kind: "agent",
	latestAt: "2026-10-12T12:00:00Z",
	modules: ["first", "second"].map((id) => ({
		agents: [],
		lead: undefined,
		status: "quiet",
		thread: thread(id),
	})),
	name: "Flow",
	start: {},
} as NonNullable<FlowProps["flow"]>;

const noop = () => undefined;

function props(focusIndex: number): FlowProps {
	return {
		contextFor: () => "",
		direction: 1,
		flow: FLOW,
		focusIndex,
		now: Date.parse("2026-10-12T12:05:00Z"),
		onBack: noop,
		onClose: noop,
		onListKeyDown: noop,
		onNewThread: noop,
		onOpenThread: noop,
		onSelect: noop,
		threadView: null,
	};
}

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/**
 * The entering card's horizontal offset in px just after stepping forward
 * once (the slide may already be under way, so only its side is stable).
 */
async function enteringOffset(direction: "ltr" | "rtl"): Promise<number> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	const view = (focusIndex: number) => (
		<DirectionProvider direction={direction}>
			<div dir={direction}>
				<MomentsFlowView {...props(focusIndex)} />
			</div>
		</DirectionProvider>
	);
	await act(async () => {
		root.render(view(0));
	});
	await act(async () => {
		root.render(view(1));
	});
	const cards = [
		...container.querySelectorAll<HTMLElement>('[data-testid="moments-focus"]'),
	];
	const entering = cards.find((card) => card.textContent?.includes("second"));
	const match = /translateX\((-?[\d.]+)px\)/.exec(
		entering?.style.transform ?? ""
	);
	return match ? Number(match[1]) : 0;
}

describe("Moments focus card travel under right-to-left", () => {
	test("in English the next card enters from the physical right", async () => {
		expect(await enteringOffset("ltr")).toBeGreaterThan(0);
	});

	test("in Arabic the next card enters from the physical left", async () => {
		expect(await enteringOffset("rtl")).toBeLessThan(0);
	});
});
