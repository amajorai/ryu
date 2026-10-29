/* @jsxImportSource @opentui/react */
import { expect, spyOn, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act, useState } from "react";
import { Spinner } from "../../components/ui/spinner.tsx";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { testRender } from "./cli-test-render.ts";

test("spinners share their timer and reduced motion releases it", async () => {
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	// SAFETY: bun-types/globals.d.ts declares clearInterval(number | Timer),
	// alongside Node's string/number/Timeout overload. Function.call selects only
	// the last ambient overload; this native callable retains both SDK inputs,
	// forwards the same handle/receiver, and preserves native refusal/errors.
	const clearNativeTimer = originalClear as (
		id: Parameters<typeof originalClear>[0] | Timer
	) => ReturnType<typeof originalClear>;
	const active = new Set<Parameters<typeof originalClear>[0] | Timer>();
	let started = 0;
	let invalid = false;
	// Forward the native timer callback, delay, arguments, and returned handle.
	// SAFETY: this transparent spy forwards every runtime argument to the same
	// native setInterval and returns its unchanged handle. Parameters selects
	// only the last DOM/Bun/Node overload; the wrapper preserves every original
	// overload's acceptance, coercion, callback arguments, and native errors.
	const trackedInterval = ((...args: Parameters<typeof originalSet>) => {
		if (args[1] === Number.POSITIVE_INFINITY) {
			invalid = true;
		}
		const id = originalSet.apply(globalThis, args);
		if (args[1] === 143) {
			started++;
			active.add(id);
		}
		return id;
	}) as typeof originalSet;
	const set = spyOn(globalThis, "setInterval").mockImplementation(
		trackedInterval
	);
	const clear = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
		active.delete(id);
		clearNativeTimer.call(globalThis, id);
	});
	let reduce!: (value: boolean) => void;
	function View() {
		const [reduced, update] = useState(false);
		reduce = update;
		return (
			<ThemeProvider reducedMotion={reduced}>
				<Spinner fps={7} frames={["A", "B"]} label="first" />
				<Spinner fps={7} frames={["A", "B"]} label="second" />
				<Spinner fps={0} frames={["Z"]} label="static" />
			</ThemeProvider>
		);
	}
	const setup = await testRender(<View />, { width: 60, height: 10 });
	try {
		await act(async () => {
			await Bun.sleep(160);
		});
		expect(started).toBe(1);
		expect(active.size).toBe(1);
		expect(invalid).toBe(false);
		await act(async () => {
			reduce(true);
		});
		expect(active.size).toBe(0);
		await act(async () => {
			await Bun.sleep(45);
		});
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("A");
		await act(async () => {
			reduce(false);
		});
		expect(started).toBe(2);
		expect(active.size).toBe(1);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		set.mockRestore();
		clear.mockRestore();
	}
	expect(active.size).toBe(0);
});

test("registry refresh preserves the host animation hook while writing other files", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-vendor-motion-"));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Response.json({
				name: "fixture",
				files: [
					{
						path: "ignored",
						target: "./hooks/use-animation.ts",
						content: "overwrite",
					},
					{
						path: "ignored",
						target: "./components/ui/tool-call.tsx",
						content: "overwrite",
					},
					{
						path: "ignored",
						target: "lib/fixture.ts",
						content: "export const fixture = true;",
					},
				],
			});
		},
	});
	try {
		await mkdir(join(root, "scripts"));
		await mkdir(join(root, "hooks"));
		await mkdir(join(root, "components/ui"), { recursive: true });
		await writeFile(join(root, "components/ui/tool-call.tsx"), "host-tool");
		await copyFile(
			resolve(import.meta.dirname, "../../scripts/vendor-termcn.ts"),
			join(root, "scripts/vendor-termcn.ts")
		);
		await copyFile(
			resolve(
				import.meta.dirname,
				"../../scripts/termcn-registry-contracts.ts"
			),
			join(root, "scripts/termcn-registry-contracts.ts")
		);
		await symlink(
			resolve(import.meta.dirname, "../../node_modules"),
			join(root, "node_modules"),
			"dir"
		);
		await writeFile(join(root, "hooks/use-animation.ts"), "host-owned");
		const child = Bun.spawn(
			[
				process.execPath,
				join(root, "scripts/vendor-termcn.ts"),
				server.url.toString(),
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		expect(await child.exited).toBe(0);
		expect(
			await readFile(join(root, "components/ui/tool-call.tsx"), "utf8")
		).toBe("host-tool");
		expect(await readFile(join(root, "hooks/use-animation.ts"), "utf8")).toBe(
			"host-owned"
		);
		expect(await readFile(join(root, "lib/fixture.ts"), "utf8")).toContain(
			"export const fixture = true;"
		);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
