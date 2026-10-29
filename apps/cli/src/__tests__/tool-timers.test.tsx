/* @jsxImportSource @opentui/react */
import { expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act, useState } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { ToolCall } from "../../components/ui/tool-call.tsx";
import {
	InputFocusProvider,
	useSetInputFocused,
} from "../core/InputFocusContext.tsx";
import { testRender } from "./cli-test-render.ts";

test("completed tool rows have no timers and running rows share animation", async () => {
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	// SAFETY: bun-types/globals.d.ts declares clearInterval(number | Timer),
	// alongside Node's string/number/Timeout overload. Function.call selects only
	// the last ambient overload; this native callable retains both SDK inputs,
	// forwards the same handle/receiver, and preserves native refusal/errors.
	const clearNativeTimer = originalClear as (
		id: Parameters<typeof originalClear>[0] | Timer
	) => ReturnType<typeof originalClear>;
	const timers = new Map<Parameters<typeof originalClear>[0] | Timer, number>();
	// SAFETY: this transparent spy forwards every runtime argument to the same
	// native setInterval and returns its unchanged handle. Parameters selects
	// only the last DOM/Bun/Node overload; the wrapper preserves every original
	// overload's acceptance, coercion, callback arguments, and native errors.
	const wrapped = ((...args: Parameters<typeof originalSet>) => {
		const id = originalSet.apply(globalThis, args);
		if (args[1] === 83 || args[1] === 100) {
			timers.set(id, args[1]);
		}
		return id;
	}) as typeof originalSet;
	const set = spyOn(globalThis, "setInterval").mockImplementation(wrapped);
	const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
		timers.delete(id);
		clearNativeTimer.call(globalThis, id);
	});
	let update!: (running: boolean) => void;
	let setFixed!: (fixed: boolean) => void;
	function View() {
		const [running, setRunning] = useState(false);
		const [fixed, updateFixed] = useState(true);
		setFixed = updateFixed;
		update = setRunning;
		return (
			<ThemeProvider reducedMotion={false}>
				{Array.from({ length: 20 }, (_, i) => (
					<ToolCall
						collapsible={false}
						duration={fixed ? 42 : undefined}
						key={i}
						name={`tool-${i}`}
						status={running && i < 2 ? "running" : "success"}
					/>
				))}
			</ThemeProvider>
		);
	}
	const setup = await testRender(<View />, { width: 80, height: 30 });
	try {
		await setup.renderOnce();
		expect(timers.size).toBe(0);
		await act(async () => {
			update(true);
		});
		expect([...timers.values()]).toEqual([83]);
		await act(async () => {
			await Bun.sleep(120);
			setFixed(false);
		});
		expect(timers.size).toBe(3);
		await setup.renderOnce();
		// The live timer reads like a settled duration: `· 42ms` or `· 0.1s`.
		const elapsed = setup
			.captureCharFrame()
			.match(/tool-0\s+· (\d+(?:\.\d)?)(ms|s)/);
		const elapsedMs =
			elapsed?.[2] === "s" ? Number(elapsed[1]) * 1000 : Number(elapsed?.[1]);
		expect(elapsedMs).toBeGreaterThanOrEqual(100);
		await act(async () => {
			await Bun.sleep(100);
			update(false);
		});
		expect(timers.size).toBe(0);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("tool-19");
		await writeFile(
			resolve(
				import.meta.dirname,
				"../../../../docs/proof/performance-sweep/cli-tool-rows.txt"
			),
			`${frame
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd()}\n`
		);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		set.mockRestore();
		clear.mockRestore();
	}
});

test("interrupted and denied rows render static without timers", async () => {
	const intervals: number[] = [];
	const originalSet = globalThis.setInterval;
	// SAFETY: transparent spy; forwards every argument to the native
	// setInterval and returns its unchanged handle (see the test above).
	const wrapped = ((...args: Parameters<typeof originalSet>) => {
		const delay = args[1];
		if (delay === 83 || delay === 100) {
			intervals.push(delay);
		}
		return originalSet.apply(globalThis, args);
	}) as typeof originalSet;
	const set = spyOn(globalThis, "setInterval").mockImplementation(wrapped);
	const setup = await testRender(
		<ThemeProvider reducedMotion={false}>
			<ToolCall
				collapsible={false}
				duration={1200}
				name="Bash"
				pendingLabel="Running"
				status="interrupted"
			/>
			<ToolCall collapsible={false} name="Edit" status="denied" />
		</ThemeProvider>,
		{ width: 60, height: 6 }
	);
	try {
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("\u2298 Bash interrupted \u00b7 1.2s");
		expect(frame).toContain("\u2717 Edit denied");
		expect(intervals).toEqual([]);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		set.mockRestore();
	}
});

test("tool disclosure keys do not consume text-input Enter", async () => {
	let focus!: (value: boolean) => void;
	function View() {
		focus = useSetInputFocused();
		return <ToolCall name="inspect" result="visible-result" status="success" />;
	}
	const setup = await testRender(
		<ThemeProvider>
			<InputFocusProvider>
				<View />
			</InputFocusProvider>
		</ThemeProvider>,
		{ width: 80, height: 15 }
	);
	const enter = async () => {
		await act(async () => {
			setup.renderer.keyInput.emit(
				"keypress",
				new KeyEvent({
					name: "return",
					sequence: "",
					shift: false,
					ctrl: false,
					meta: false,
					option: false,
					eventType: "press",
					repeated: false,
					number: false,
					raw: "",
					source: "raw",
				})
			);
		});
		await setup.renderOnce();
	};
	try {
		await enter();
		expect(setup.captureCharFrame()).toContain("visible-result");
		await act(async () => {
			focus(true);
		});
		await enter();
		expect(setup.captureCharFrame()).toContain("visible-result");
		await act(async () => {
			focus(false);
		});
		await enter();
		expect(setup.captureCharFrame()).not.toContain("visible-result");
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
