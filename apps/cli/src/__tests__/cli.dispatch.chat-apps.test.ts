// Dispatcher tests for one-shot chat and app-contributed subcommands (including
// the built-in mail resource requests). The HTTP layer is mocked via an injected
// CoreApi, so nothing hits a Core node.

import { expect, test } from "bun:test";
import type { AppInfo } from "@ryuhq/core-client/plugins";
import { runCli } from "../cli/dispatch.ts";
import {
	type CapturedResourceCall,
	chatOutputObservation,
	mailApp,
	makeIo,
	stubApi,
} from "./cli-dispatch-fixtures.ts";

// ── one-shot chat ─────────────────────────────────────────────────────────────

test("chat streams assistant deltas to stdout and exits 0", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hello", "there"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, turns, _o, handlers) => {
				expect(turns[0]?.content).toBe("hello there");
				handlers.onTextDelta("Hi ");
				handlers.onTextDelta("back");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("Hi back");
});

test("chat --json collects the full reply into a JSON envelope", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi", "--json"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onTextDelta("full ");
				handlers.onTextDelta("reply");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	const parsed = chatOutputObservation.parse(JSON.parse(cap.out()));
	expect(parsed.text).toBe("full reply");
});

test("chat opens a continuation turn on a new paragraph", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi", "--json"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onTextDelta("Done step A.");
				handlers.onTurnBoundary?.();
				handlers.onTextDelta("Now step B");
				handlers.onTextDelta(".");
				handlers.onDone();
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(0);
	const parsed = chatOutputObservation.parse(JSON.parse(cap.out()));
	expect(parsed.text).toBe("Done step A.\n\nNow step B.");
});

test("chat surfaces a stream error as exit 1", async () => {
	const cap = makeIo();
	const code = await runCli(["chat", "hi"], {
		io: cap.io,
		api: stubApi({
			streamChat: (_t, _turns, _o, handlers) => {
				handlers.onError("stream blew up");
				return Promise.resolve();
			},
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("stream blew up");
});

// ── app-contributed subcommands (`ryu <app> <cmd>`) ────────────────────────────

test("app command routes to execAppCommand with the right plugin id + route", async () => {
	const cap = makeIo();
	let capturedId = "";
	let capturedMethod = "";
	let capturedPath = "";
	const code = await runCli(["mail-contributor", "status"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: (_t, pluginId, cmd) => {
				capturedId = pluginId;
				capturedMethod = cmd.method;
				capturedPath = cmd.path;
				return Promise.resolve({ status: 200, body: "ok" });
			},
		}),
	});
	expect(code).toBe(0);
	expect(capturedId).toBe("mail-contributor");
	expect(capturedPath).toBe("/status");
	expect(capturedMethod).toBe("GET");
	expect(cap.out()).toContain("ok");
	expect(cap.err()).toBe("");
});

test("app command passes trailing args through to the sidecar", async () => {
	const cap = makeIo();
	let receivedArgs: string[] = [];
	await runCli(["mail-contributor", "send", "a@b.com", "hi"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: (_t, _id, _cmd, args) => {
				receivedArgs = args;
				return Promise.resolve({ status: 200, body: "sent" });
			},
		}),
	});
	expect(receivedArgs).toEqual(["a@b.com", "hi"]);
});

test("an app id never shadows a built-in command", async () => {
	const cap = makeIo();
	// An app accidentally named `list` must NOT intercept `ryu list`; the built-in
	// runs (fetchApps is consulted by the built-in itself, once) and the
	// app-command fall-through (hence execAppCommand) is never reached.
	const listApp: AppInfo = { ...mailApp, id: "list", name: "List" };
	const code = await runCli(["list"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([listApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("ENABLED");
});

test("`ryu <app>` with no subcommand lists the app's commands", async () => {
	const cap = makeIo();
	const code = await runCli(["mail-contributor"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("status");
	expect(cap.out()).toContain("Show inbox status");
	expect(cap.out()).toContain("ryu-cli mail-contributor send");
});

test("unknown subcommand for a known app is a usage error listing options", async () => {
	const cap = makeIo();
	const code = await runCli(["mail-contributor", "bogus"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command 'bogus'");
	expect(cap.err()).toContain("status");
	expect(cap.err()).toContain("send");
});

test("a disabled app does not contribute commands (falls through to unknown)", async () => {
	const cap = makeIo();
	const disabled: AppInfo = { ...mailApp, enabled: false };
	const code = await runCli(["mail-contributor", "status"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([disabled]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command: mail");
});

test("an unknown app id still exits 2 with the classic message", async () => {
	const cap = makeIo();
	const code = await runCli(["frobnicate"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([mailApp]) }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown command");
});

test("a non-2xx status from the sidecar maps to exit 1 with the body on stderr", async () => {
	const cap = makeIo();
	const code = await runCli(["mail-contributor", "status"], {
		io: cap.io,
		api: stubApi({
			fetchApps: () => Promise.resolve([mailApp]),
			execAppCommand: () => Promise.resolve({ status: 500, body: "boom" }),
		}),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("boom");
});

test("built-in mail sends resource requests with JSON bodies", async () => {
	const cap = makeIo();
	let called: CapturedResourceCall = {};
	const code = await runCli(
		[
			"mail",
			"send",
			"inbox-1",
			'{"to":["person@example.com"],"subject":"Hi","text":"Body"}',
		],
		{
			io: cap.io,
			api: stubApi({
				call: (_target, path, options) => {
					called = { body: options?.body, method: options?.method, path };
					return Promise.resolve({ message: { id: "sent-1" } });
				},
			}),
		}
	);
	expect(code).toBe(0);
	expect(called).toEqual({
		body: { to: ["person@example.com"], subject: "Hi", text: "Body" },
		method: "POST",
		path: "/api/mail/inboxes/inbox-1/send",
	});
});
