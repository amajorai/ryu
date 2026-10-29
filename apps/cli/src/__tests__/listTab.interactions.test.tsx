/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import {
	InputFocusProvider,
	useSetInputFocused,
} from "../core/InputFocusContext.tsx";
import type { ListLoader, ListTabProps } from "../ui/ListTab.tsx";
import { ListTab } from "../ui/ListTab.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
let setInputFocused: ((focused: boolean) => void) | null = null;

function CaptureFocus() {
	setInputFocused = useSetInputFocused();
	return null;
}

function Harness({
	active = true,
	load,
	onActivate,
	onSecondary,
}: Pick<ListTabProps, "active" | "load" | "onActivate" | "onSecondary">) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<InputFocusProvider>
					<CaptureFocus />
					<ListTab
						active={active}
						load={load}
						onActivate={onActivate}
						onSecondary={onSecondary}
					/>
				</InputFocusProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

afterEach(async () => {
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	setInputFocused = null;
});

async function render(
	props: Pick<ListTabProps, "active" | "load" | "onActivate" | "onSecondary">
): Promise<void> {
	testSetup = await testRender(<Harness {...props} />, {
		width: 80,
		height: 24,
	});
	if (props.active === false) {
		await testSetup.flush({ maxPasses: 12 });
	} else {
		await waitForFrame(
			() => testSetup?.captureCharFrame().includes("First item") ?? false
		);
	}
}

async function waitForFrame(predicate: () => boolean): Promise<void> {
	if (!testSetup) {
		throw new Error("list renderer is not mounted");
	}
	for (let pass = 0; pass < 20 && !predicate(); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await act(async () => {
			await testSetup?.renderOnce();
		});
	}
	if (!predicate()) {
		throw new Error(`List render did not match: ${frame()}`);
	}
}

async function press(
	input: "enter" | "j" | "k" | "r" | "down" | "up"
): Promise<void> {
	if (!testSetup) {
		throw new Error("list renderer is not mounted");
	}
	await act(async () => {
		if (input === "enter") {
			testSetup?.mockInput.pressEnter();
		} else if (input === "down" || input === "up") {
			testSetup?.mockInput.pressArrow(input);
		} else {
			testSetup?.mockInput.pressKey(input);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await testSetup.flush({ maxPasses: 12 });
}

function frame(): string {
	if (!testSetup) {
		throw new Error("list renderer is not mounted");
	}
	return testSetup.captureCharFrame();
}

test("list navigation, activation, secondary action, and reload work through keys", async () => {
	const events: string[] = [];
	let loads = 0;
	const load: ListLoader = async () => {
		loads += 1;
		return [
			{
				id: "first",
				title: loads === 1 ? "First item" : `First item ${loads}`,
			},
			{ id: "second", title: "Second item" },
		];
	};
	await render({
		active: true,
		load,
		onActivate: (row) => {
			events.push(`enter:${row.id}`);
			return `opened ${row.title}`;
		},
		onSecondary: (row) => {
			events.push(`secondary:${row.id}`);
			return `used ${row.title}`;
		},
	});

	await press("j");
	expect(
		frame()
			.split("\n")
			.some((row) => row.includes("› Second item"))
	).toBe(true);
	await press("up");
	expect(
		frame()
			.split("\n")
			.some((row) => row.includes("› First item"))
	).toBe(true);
	await press("down");
	await press("k");
	expect(
		frame()
			.split("\n")
			.some((row) => row.includes("› First item"))
	).toBe(true);
	await press("j");
	await press("enter");
	expect(events).toEqual(["enter:second"]);
	expect(frame()).toContain("opened Second item");
	await act(async () => {
		testSetup?.mockInput.pressKey("a");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await testSetup?.flush({ maxPasses: 12 });
	expect(events).toEqual(["enter:second", "secondary:second"]);
	expect(frame()).toContain("used Second item");

	await press("r");
	await waitForFrame(() => frame().includes("First item 2"));
	expect(loads).toBe(2);
});

test("inactive and input-focused lists ignore navigation and activation keys", async () => {
	const events: string[] = [];
	let loads = 0;
	const load: ListLoader = async () => {
		loads += 1;
		return [
			{ id: "first", title: "First item" },
			{ id: "second", title: "Second item" },
		];
	};
	await render({
		active: true,
		load,
		onActivate: (row) => {
			events.push(`enter:${row.id}`);
			return undefined;
		},
	});

	await act(async () => {
		setInputFocused?.(true);
	});
	await press("down");
	await press("enter");
	expect(events).toEqual([]);
	expect(
		frame()
			.split("\n")
			.some((row) => row.includes("› First item"))
	).toBe(true);

	await act(async () => {
		setInputFocused?.(false);
	});
	await act(async () => {
		testSetup?.renderer.destroy();
	});
	testSetup = null;

	await render({
		active: false,
		load,
		onActivate: (row) => {
			events.push(`enter:${row.id}`);
			return undefined;
		},
	});
	await press("j");
	await press("enter");
	expect(loads).toBe(1);
	expect(events).toEqual([]);
	expect(frame()).toContain("No items");
});
