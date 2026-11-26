import { afterAll, expect, test } from "bun:test";
import { toTarget } from "@/src/lib/api/client.ts";
import { subscribeChannel } from "@/src/lib/api/eventStream.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostShellServices } from "./PluginHostPanel-services-shell.ts";

// `shell.eventsSubscribe` rides the sidebar grant, which any app may hold. The
// node's event stream carries the rows of feeds that have grants of their own,
// so the shell grant alone must open none of them, and an app that does hold a
// feed's grant gets a change signal, never the row.

// One frame per channel, as a node sends them, each with a marked row. The
// stream ends with a `navigation` frame, a channel no app frame is ever served,
// which tells the test that every frame before it was dispatched.
const ROWS: [string, unknown][] = [
	["activity", { id: "a1", title: "fixture-row", metadata: { k: "fixture" } }],
	[
		"approvals",
		{
			type: "created",
			request: { id: "ap1", question: "fixture-row", action: { tool: "x" } },
		},
	],
	["notifications", { title: "fixture-row", body: "fixture-row" }],
	[
		"downloads",
		{
			type: "snapshot",
			tasks: [{ label: "fixture-row", dest_path: "/fixture-row/file" }],
		},
	],
	["quests", { id: "q1", title: "fixture-row" }],
	["monitors", { id: "m1", name: "fixture-row" }],
	["navigation", { end: true }],
];
const STREAM = ROWS.map(
	([channel, row]) => `event: ${channel}\ndata: ${JSON.stringify(row)}\n\n`
).join("");
const ALL_CHANNELS = ROWS.map(([channel]) => channel);

const paths: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		paths.push(new URL(request.url).pathname);
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(STREAM));
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } }
		);
	},
});
afterAll(() => server.stop(true));

let scope = 0;
/** Subscribe a frame with `grants` to `channels`; return every event it got. */
async function eventsFor(grants: string[], channels: string[]) {
	scope += 1;
	// A token of its own gives each call its own connection and its own stream.
	const node = {
		url: `${server.url.toString().replace(/\/$/, "")}/node`,
		token: `fixture-node-token-${scope}`,
		userJwt: null,
	};
	const context = {
		approvedGrantList: grants,
		companion: { pluginId: "com.example.plain" },
		node,
		openTab: () => undefined,
	} as unknown as PluginHostServicesContext;
	const services = buildPluginHostShellServices(context);
	const events: string[] = [];
	let ended = false;
	const leave = subscribeChannel(toTarget(node), "navigation", () => {
		ended = true;
	});
	const frame = new AbortController();
	const subscription = services.shellEventsSubscribe?.(
		{ channels },
		(delta) => events.push(delta),
		frame.signal
	);
	const deadline = Date.now() + 5000;
	while (!ended) {
		if (Date.now() > deadline) {
			throw new Error("the stream fixture did not reach its last frame");
		}
		await Bun.sleep(10);
	}
	frame.abort();
	await subscription;
	leave();
	return events;
}

test("the shell grant alone gets no event from any channel", async () => {
	expect(await eventsFor(["shell:integrate"], ALL_CHANNELS)).toEqual([]);
	expect(paths).toContain("/node/api/events/all");
});

test("the activity grant gets a signal for activity, without the row", async () => {
	const events = await eventsFor(
		["shell:integrate", "activity:read"],
		ALL_CHANNELS
	);
	expect(events).toEqual(['{"channel":"activity"}']);
});

test("approvals and monitors grants get signals; downloads and quests are never served", async () => {
	const events = await eventsFor(
		["shell:integrate", "approvals:crud", "monitors:crud", "quests:crud"],
		ALL_CHANNELS
	);
	expect(events).toEqual([
		'{"channel":"approvals"}',
		'{"channel":"notifications"}',
		'{"channel":"monitors"}',
	]);
});

test("a frame that asks for no served channel gets nothing, whatever it holds", async () => {
	expect(
		await eventsFor(
			["shell:integrate", "activity:read", "approvals:crud", "monitors:crud"],
			["navigation", "not-a-channel"]
		)
	).toEqual([]);
});
