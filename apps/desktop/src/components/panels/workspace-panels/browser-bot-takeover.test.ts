import { describe, expect, test } from "bun:test";
import { parseBotLanes } from "./browser-bot-lanes.ts";
import {
	botTakeoverFailure,
	botTakeoverInputPath,
	botTakeoverPath,
	MAX_TAKEOVER_EVENTS,
	type TakeoverInputEvent,
	TakeoverInputQueue,
	takeoverButton,
	takeoverPagePoint,
	takeoverWheelDelta,
} from "./browser-bot-takeover.ts";

const BASE = "/api/ext/@ryu/browser";

function move(x: number): TakeoverInputEvent {
	return {
		action: "move",
		button: "none",
		buttons: 0,
		click_count: 0,
		modifiers: {},
		type: "mouse",
		x,
		y: 1,
	};
}

function key(value: string): TakeoverInputEvent {
	return { action: "down", code: "", key: value, modifiers: {}, type: "key" };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("parseBotLanes with a takeover", () => {
	test("reads the lane's open request", () => {
		const lanes = parseBotLanes({
			lanes: [
				{
					agent_id: "agent-a",
					tabs: [{ id: "t1", title: "Sign in", url: "https://a.test/" }],
					takeover: {
						expires_at: "2026-11-17T12:10:00.000Z",
						reason: "Sign in to a.test",
						requested_at: "2026-11-17T12:00:00.000Z",
						status: "pending",
						tab_id: "t1",
					},
				},
				{ agent_id: "agent-b", tabs: [] },
			],
		});
		expect(lanes[0]?.takeover).toEqual({
			expiresAt: "2026-11-17T12:10:00.000Z",
			reason: "Sign in to a.test",
			status: "pending",
			tabId: "t1",
		});
		expect(lanes[1]).toEqual({ agentId: "agent-b", tabs: [] });
	});
});

describe("takeover paths", () => {
	test("encode the lane and the tab", () => {
		const selection = { agentId: "agent a/1", tabId: "t#1" };
		expect(botTakeoverPath(BASE, selection)).toBe(
			`${BASE}/lanes/agent%20a%2F1/tabs/t%231/takeover`
		);
		expect(botTakeoverInputPath(BASE, selection)).toBe(
			`${BASE}/lanes/agent%20a%2F1/tabs/t%231/input`
		);
	});
});

describe("botTakeoverFailure", () => {
	test("reads the refusal from the failed call's status", () => {
		expect(botTakeoverFailure(new Error("423"))).toBe("busy");
		expect(botTakeoverFailure(new Error("409"))).toBe("closed");
		expect(botTakeoverFailure(new Error("500"))).toBe("other");
		expect(botTakeoverFailure("423")).toBe("other");
	});
});

describe("takeoverPagePoint", () => {
	const frame = { height: 600, width: 1200 };

	test("maps a pointer over a picture that fills the box", () => {
		expect(
			takeoverPagePoint(
				{ x: 310, y: 170 },
				{ height: 300, left: 10, top: 20, width: 600 },
				frame
			)
		).toEqual({ x: 600, y: 300 });
	});

	test("leaves out the bars around a letterboxed picture", () => {
		// A 600 x 600 box shows the 2:1 picture 600 x 300, with 150 px bars.
		const box = { height: 600, left: 0, top: 0, width: 600 };
		expect(takeoverPagePoint({ x: 300, y: 100 }, box, frame)).toBe(null);
		expect(takeoverPagePoint({ x: 300, y: 500 }, box, frame)).toBe(null);
		expect(takeoverPagePoint({ x: 0, y: 150 }, box, frame)).toEqual({
			x: 0,
			y: 0,
		});
		expect(takeoverPagePoint({ x: 600, y: 450 }, box, frame)).toEqual({
			x: 1200,
			y: 600,
		});
	});

	test("answers null before the picture has a size", () => {
		const box = { height: 0, left: 0, top: 0, width: 0 };
		expect(takeoverPagePoint({ x: 1, y: 1 }, box, frame)).toBe(null);
		expect(
			takeoverPagePoint(
				{ x: 1, y: 1 },
				{ height: 10, left: 0, top: 0, width: 10 },
				{ height: 0, width: 0 }
			)
		).toBe(null);
	});
});

describe("takeoverButton and takeoverWheelDelta", () => {
	test("name the mouse buttons", () => {
		expect([0, 1, 2, 3].map(takeoverButton)).toEqual([
			"left",
			"middle",
			"right",
			"none",
		]);
	});

	test("turn wheel lines into bounded pixels", () => {
		expect(takeoverWheelDelta(120, 0)).toBe(120);
		expect(takeoverWheelDelta(3, 1)).toBe(120);
		expect(takeoverWheelDelta(1e9, 0)).toBe(10_000);
		expect(takeoverWheelDelta(-1e9, 0)).toBe(-10_000);
	});
});

describe("TakeoverInputQueue", () => {
	test("sends events in order, one request at a time", async () => {
		const sent: string[][] = [];
		let release: (ok: boolean) => void = () => undefined;
		const queue = new TakeoverInputQueue(
			(events) => {
				sent.push(
					events.map((event) => (event.type === "key" ? event.key : ""))
				);
				return new Promise<boolean>((resolve) => {
					release = resolve;
				});
			},
			() => undefined
		);
		queue.push(key("a"));
		queue.push(key("b"));
		queue.push(key("c"));
		await settle();
		expect(sent).toEqual([["a"]]);
		release(true);
		await settle();
		expect(sent).toEqual([["a"], ["b", "c"]]);
	});

	test("keeps only the newest of a run of pointer moves", async () => {
		const sent: TakeoverInputEvent[][] = [];
		let release: (ok: boolean) => void = () => undefined;
		const queue = new TakeoverInputQueue(
			(events) => {
				sent.push(events);
				return new Promise<boolean>((resolve) => {
					release = resolve;
				});
			},
			() => undefined
		);
		queue.push(key("a"));
		queue.push(move(1));
		queue.push(move(2));
		queue.push(move(3));
		queue.push(key("b"));
		queue.push(move(4));
		await settle();
		release(true);
		await settle();
		expect(sent[1]).toEqual([move(3), key("b"), move(4)]);
	});

	test("never sends more events than one request may carry", async () => {
		const sizes: number[] = [];
		let first = true;
		let release: (ok: boolean) => void = () => undefined;
		const queue = new TakeoverInputQueue(
			(events) => {
				sizes.push(events.length);
				if (first) {
					first = false;
					return new Promise<boolean>((resolve) => {
						release = resolve;
					});
				}
				return Promise.resolve(true);
			},
			() => undefined
		);
		for (let index = 0; index < MAX_TAKEOVER_EVENTS + 11; index += 1) {
			queue.push(key("a"));
		}
		release(true);
		await settle();
		expect(sizes).toEqual([1, MAX_TAKEOVER_EVENTS, 10]);
	});

	test("drops what is waiting and reports once the sidecar refuses", async () => {
		let refused = 0;
		const sent: number[] = [];
		const queue = new TakeoverInputQueue(
			(events) => {
				sent.push(events.length);
				return Promise.reject(new Error("409"));
			},
			() => {
				refused += 1;
			}
		);
		queue.push(key("a"));
		queue.push(key("b"));
		await settle();
		expect(refused).toBe(1);
		expect(sent).toEqual([1]);
	});

	test("sends nothing after it is closed", async () => {
		const sent: number[] = [];
		const queue = new TakeoverInputQueue(
			(events) => {
				sent.push(events.length);
				return Promise.resolve(true);
			},
			() => undefined
		);
		queue.close();
		queue.push(key("a"));
		await settle();
		expect(sent).toEqual([]);
	});
});
