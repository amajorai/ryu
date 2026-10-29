// Tests for `ryu init <name> [--template <t>]` (cli/builtins/lifecycle.ts initCommand).
//
// `init` owns no templates: it shells out to create-ryu-app, the scaffolding source
// of truth. So what these tests pin is the CONTRACT with that child — the argv it is
// handed, that its output is forwarded verbatim instead of paraphrased, and that its
// exit status becomes the CLI's. The runner is injected (ScaffoldRunner, the same
// fake-injection seam as CoreApi), so no process is ever spawned here.

import { expect, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../cli/dispatch.ts";
import type {
	CliIO,
	CoreApi,
	ScaffoldResult,
	ScaffoldRunner,
} from "../cli/types.ts";

const initOutputSchema = z.looseObject({
	name: z.string(),
	template: z.string().nullable(),
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
});

function makeIo() {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s: Parameters<CliIO["out"]>[0]) => {
				outBuf += s;
			},
			err: (s: Parameters<CliIO["err"]>[0]) => {
				errBuf += s;
			},
		},
		out: () => outBuf,
		err: () => errBuf,
	};
}

/** A CoreApi whose every method rejects: `init` is a purely local action, so a
 *  rejecting stub proves it never talks to a node. */
function noNetworkApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: () =>
			Promise.reject(new Error("unexpected execAppCommand call")),
		streamChat: () => Promise.reject(new Error("unexpected streamChat call")),
	};
}

/** A fake scaffolder recording the argv it was handed. */
function fakeScaffold(result: Partial<ScaffoldResult> = {}) {
	let seen: string[] | null = null;
	let calls = 0;
	return {
		run: (argv: Parameters<ScaffoldRunner>[0]) => {
			seen = argv;
			calls += 1;
			return Promise.resolve({
				exitCode: 0,
				stdout: "",
				stderr: "",
				...result,
			});
		},
		argv: () => seen,
		calls: () => calls,
	};
}

test("init <name>: hands create-ryu-app the bare name and exits 0", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold({ stdout: "  created my-app/ (agent)\n" });
	const code = await runCli(["init", "my-app"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(code).toBe(0);
	expect(scaffold.argv()).toEqual(["my-app"]);
	// The child's own "created …" block is forwarded, not paraphrased.
	expect(cap.out()).toContain("created my-app/ (agent)");
});

test("init: no --template is passed through as ABSENT, not a mirrored default", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold();
	await runCli(["init", "my-app"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	// Mirroring create-ryu-app's default here would let the two disagree the day
	// it changes — the flag is simply omitted so the child decides.
	expect(scaffold.argv()).not.toContain("--template");
});

test("init --template <t>: forwarded verbatim (the tui never validates templates)", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold();
	const code = await runCli(["init", "my-app", "--template", "app"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(code).toBe(0);
	expect(scaffold.argv()).toEqual(["my-app", "--template", "app"]);
});

test("init --template=<t>: the inline form resolves to the same argv", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold();
	await runCli(["init", "my-plugin", "--template=hook-plugin"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(scaffold.argv()).toEqual(["my-plugin", "--template", "hook-plugin"]);
});

test("init: a failing scaffolder is exit 1 with its stderr forwarded", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold({
		exitCode: 1,
		stderr: "error: unknown template: nope\n",
	});
	const code = await runCli(["init", "my-app", "--template", "nope"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(code).toBe(1);
	// The child owns the template list, so the child's message is the message.
	expect(cap.err()).toContain("unknown template: nope");
});

test("init --json: one machine-readable envelope carrying the child's output", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold({ stdout: "  created my-app/ (app)\n" });
	const code = await runCli(["init", "my-app", "--template", "app", "--json"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(code).toBe(0);
	// Parseable: the child's text is INSIDE the envelope because its output is
	// captured, never inherited onto the real stdout.
	const parsed = initOutputSchema.parse(JSON.parse(cap.out()));
	expect(parsed.name).toBe("my-app");
	expect(parsed.template).toBe("app");
	expect(parsed.exitCode).toBe(0);
	expect(parsed.stdout).toContain("created my-app/");
});

test("init without a name is a usage error (exit 2) and never spawns", async () => {
	const cap = makeIo();
	const scaffold = fakeScaffold();
	const code = await runCli(["init"], {
		io: cap.io,
		api: noNetworkApi(),
		scaffold: scaffold.run,
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Usage: ryu-cli init <name>");
	expect(scaffold.calls()).toBe(0);
});

test("help lists init and the --template flag", async () => {
	const cap = makeIo();
	const code = await runCli(["--help"], { io: cap.io, api: noNetworkApi() });
	expect(code).toBe(0);
	expect(cap.out()).toContain("ryu-cli init <name>");
	expect(cap.out()).toContain("--template <t>");
});
