/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "./cli-test-render.ts";

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

function Harness() {
	const [value, setValue] = useState("");
	return (
		<box flexDirection="column">
			<input focused={true} onInput={setValue} value={value} />
			<text>{value}</text>
		</box>
	);
}

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
});

test("focused native OpenTUI input retains a typed multi-character value", async () => {
	testSetup = await testRender(<Harness />, { width: 60, height: 12 });
	await testSetup.renderOnce();
	await act(async () => {
		await testSetup?.mockInput.typeText("Hello from CLI", 50);
	});
	await testSetup.flush({ maxPasses: 12 });
	expect(testSetup.captureCharFrame()).toContain("Hello from CLI");
});
