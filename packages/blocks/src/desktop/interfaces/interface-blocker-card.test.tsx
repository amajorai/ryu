import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { BlockerCard } = await import("./interface-blocker-card.tsx");
const { blockerKindWord } = await import("@ryuhq/protocol/interfaces");

import type {
	InterfaceBlocker,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";

afterAll(() => {
	GlobalRegistrator.unregister();
});

let setOutside: ((snapshot: InterfaceSnapshot) => void) | null = null;
let unmount: (() => void) | null = null;

function Host({
	initial,
	port,
	threadId,
}: {
	initial: InterfaceSnapshot;
	port: InterfacePort;
	threadId: string;
}) {
	const [snapshot, setSnapshot] = useState(initial);
	setOutside = setSnapshot;
	const heading = useRef<HTMLHeadingElement>(null);
	return (
		<div>
			<h1 ref={heading} tabIndex={-1}>
				Game
			</h1>
			<BlockerCard
				agentName="Di"
				clock={FIXTURE_CLOCK}
				fallbackFocus={heading}
				nowMs={FIXTURE_NOW}
				onClose={() => undefined}
				port={port}
				snapshot={snapshot}
				threadId={threadId}
			/>
		</div>
	);
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}

async function mount(snapshot: InterfaceSnapshot, threadId: string) {
	const opened: string[] = [];
	const port: InterfacePort = {
		closeThread: () => undefined,
		openThread: (id) => opened.push(id),
		startThread: () => undefined,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() =>
		root.render(<Host initial={snapshot} port={port} threadId={threadId} />)
	);
	unmount = () => {
		act(() => root.unmount());
		container.remove();
	};
	await flush();
	return opened;
}

afterEach(() => {
	unmount?.();
	unmount = null;
});

function withBlocker(blocker: InterfaceBlocker): {
	snapshot: InterfaceSnapshot;
	threadId: string;
} {
	const base = usefulStateFixture();
	const thread = base.threads.find(
		(item) => item.blocker?.title === "Tests failed"
	);
	if (!thread) {
		throw new Error("fixture has no Tests failed thread");
	}
	return {
		snapshot: {
			...base,
			threads: base.threads.map((item) =>
				item.id === thread.id ? { ...item, blocker } : item
			),
		},
		threadId: thread.id,
	};
}

const card = () => document.querySelector("[data-blocker-card]");
const buttons = () =>
	[...(card()?.querySelectorAll("button") ?? [])].map(
		(button) => button.textContent
	);

describe("BlockerCard (test 13g)", () => {
	test("Open only (no Retry); Open opens the thread", async () => {
		const base = usefulStateFixture();
		const thread = base.threads.find(
			(item) => item.blocker?.title === "Tests failed"
		);
		const opened = await mount(base, thread?.id ?? "");
		expect(buttons()).toEqual(["Open", "Close"]);
		expect(card()?.textContent).toContain("Tests failed");
		expect(card()?.textContent).toContain("20m ago");
		act(() => (card()?.querySelector("button") as HTMLButtonElement).click());
		expect(opened).toEqual([thread?.id ?? ""]);
	});

	test("estimate reads Likely; clearsAt only when present; null at reads time unknown", async () => {
		const { snapshot, threadId } = withBlocker({
			at: null,
			clearsAt: "2026-10-16T15:10:00Z",
			detail: "Weekly window used up",
			kind: "rate-limited",
			source: "estimate",
			title: "Plan limit hit",
		});
		await mount(snapshot, threadId);
		const text = card()?.textContent ?? "";
		expect(text).toContain("Likely Plan limit hit");
		expect(text).toContain("clears 15:10");
		expect(text).toContain("time unknown");
	});

	test("no clears line without clearsAt", async () => {
		const base = usefulStateFixture();
		const thread = base.threads.find(
			(item) => item.blocker?.title === "Tests failed"
		);
		await mount(base, thread?.id ?? "");
		expect(card()?.textContent ?? "").not.toContain("clears");
	});

	test("redacted: a full snapshot marked redacted shows the kind word and no detail", async () => {
		const base = usefulStateFixture();
		const thread = base.threads.find(
			(item) => item.blocker?.title === "Tests failed"
		);
		const detail = thread?.blocker?.detail;
		expect(detail).toBeTruthy();
		await mount({ ...base, privacy: "redacted" }, thread?.id ?? "");
		const text = card()?.textContent ?? "";
		expect(card()).not.toBeNull();
		expect(text).toContain(blockerKindWord("command-failed"));
		expect(text).not.toContain("Tests failed");
		expect(text).not.toContain(detail ?? "never");
		expect(buttons()).toEqual(["Open", "Close"]);
	});

	test("the blocker leaving shows Cleared and focuses Close", async () => {
		const base = usefulStateFixture();
		const thread = base.threads.find(
			(item) => item.blocker?.title === "Tests failed"
		);
		await mount(base, thread?.id ?? "");
		act(() =>
			setOutside?.({
				...base,
				threads: base.threads.map((item) =>
					item.id === thread?.id ? { ...item, blocker: null } : item
				),
			})
		);
		await flush();
		expect(card()?.textContent).toContain("Cleared");
		expect(document.activeElement?.textContent).toBe("Close");
	});
});
