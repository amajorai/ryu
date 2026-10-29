/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatQueueBar } from "../components/ChatQueueBar.tsx";
import { ChatQueueOverlay } from "../components/ChatQueueOverlay.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { testRender } from "./cli-test-render.ts";

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
});

function Harness({ children }: { children: ReactNode }) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<box height="100%" width="100%">
				{children}
			</box>
		</ThemeProvider>
	);
}

async function settle(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});
}

test("queue bar renders bounded previews and focus/clear hints", async () => {
	testSetup = await testRender(
		<Harness>
			<ChatQueueBar
				items={["first prompt", "second prompt", "hidden prompt"]}
				maxPreviewLength={18}
				maxPreviewRows={2}
				onClear={() => undefined}
				onFocus={() => undefined}
			/>
		</Harness>,
		{ width: 80, height: 14 }
	);
	await settle(testSetup);

	const frame = testSetup.captureCharFrame();
	expect(frame).toContain("Queue · 3 queued");
	expect(frame).toContain("first prompt");
	expect(frame).toContain("second prompt");
	expect(frame).toContain("+1 more");
	expect(frame).toContain("Enter inspect");
	expect(frame).toContain("c clear");
	expect(frame).not.toContain("hidden prompt");
});

function QueueOverlayHarness({ events }: { events: string[] }) {
	const [items, setItems] = useState(["first", "second", "third"]);
	const [selectedIndex, setSelectedIndex] = useState(0);

	return (
		<ChatQueueOverlay
			focused
			items={items}
			maxVisibleRows={2}
			onCancel={() => events.push("cancel")}
			onClear={() => {
				events.push("clear");
				setItems([]);
			}}
			onRemove={(index) => {
				events.push(`remove:${index}`);
				setItems((current) =>
					current.filter((_, itemIndex) => itemIndex !== index)
				);
			}}
			onSelect={(index) => {
				events.push(`select:${index}`);
				setSelectedIndex(index);
			}}
			selectedIndex={selectedIndex}
		/>
	);
}

test("focused queue overlay emits selection, remove, clear, and cancel intents", async () => {
	const events: string[] = [];
	testSetup = await testRender(
		<Harness>
			<QueueOverlayHarness events={events} />
		</Harness>,
		{ width: 80, height: 20 }
	);
	await settle(testSetup);

	await act(async () => {
		await testSetup?.mockInput.pressArrow("down");
	});
	await settle(testSetup);
	expect(events).toContain("select:1");
	expect(testSetup.captureCharFrame()).toContain("› 2.");

	await act(async () => {
		testSetup?.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
	await settle(testSetup);
	expect(events).toContain("cancel");

	await act(async () => {
		testSetup?.mockInput.pressKey("x");
	});
	await settle(testSetup);
	expect(events).toContain("remove:1");

	await act(async () => {
		testSetup?.mockInput.pressKey("c");
	});
	await settle(testSetup);
	expect(events).toContain("clear");
	expect(testSetup.captureCharFrame()).toContain("Queue is empty");
});
