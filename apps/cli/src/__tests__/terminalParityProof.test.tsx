/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { TerminalParityProof } from "../proof/terminal-parity-proof.tsx";
import { testRender } from "./cli-test-render.ts";

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
});

test("captures the composed terminal parity proof frame", async () => {
	testSetup = await testRender(<TerminalParityProof />, {
		height: 32,
		width: 128,
	});
	await testSetup.renderOnce();
	const frame = testSetup.captureCharFrame();

	expect(frame).toContain("CLI terminal parity · proof artifact");
	expect(frame).toContain("Queue · 2 queued");
	expect(frame).toContain("Transcript");
	expect(frame).toContain("/agent");
	expect(frame).toContain("Modes: system · light · dark");
	expect(frame).toContain("Ryu Mono");
});

test("captures the full queue overlay proof state", async () => {
	testSetup = await testRender(<TerminalParityProof showQueueOverlay />, {
		height: 32,
		width: 128,
	});
	await testSetup.renderOnce();
	const frame = testSetup.captureCharFrame();

	expect(frame).toContain("Queued prompts");
	expect(frame).toContain("2 queued");
	expect(frame).toContain("⇧↑↓ reorder");
	expect(frame).toContain("Esc cancel");
});
