// The real child runner behind `ryu secrets run`: aborting its signal stops
// the child (`run --watch` restarts this way) and still yields its exit code.

import { expect, test } from "bun:test";
import { runProcess } from "../cli/api.ts";

test("runProcess stops the child when its signal aborts", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const exit = runProcess(
		["sleep", "30"],
		{ PATH: process.env.PATH ?? "" },
		{
			signal: controller.signal,
		}
	);
	setTimeout(() => controller.abort("restart"), 50);
	const code = await exit;
	expect(code).not.toBe(0);
	expect(Date.now() - started).toBeLessThan(10_000);
});

test("runProcess without a signal returns the child's exit code", async () => {
	expect(
		await runProcess(["sh", "-c", "exit 7"], { PATH: process.env.PATH ?? "" })
	).toBe(7);
});
