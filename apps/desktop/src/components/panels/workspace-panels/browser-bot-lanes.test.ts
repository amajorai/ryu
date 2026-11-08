import { describe, expect, test } from "bun:test";
import {
	botLaneScreencastPath,
	parseBotLanes,
	parseBotLiveFrame,
	pickBotLaneTab,
} from "./browser-bot-lanes.ts";

const lanes = [
	{ agentId: "agent-a", tabs: [] },
	{
		agentId: "agent-b",
		tabs: [
			{ id: "t1", title: "Inbox", url: "https://mail.example.com/" },
			{ id: "t2", title: "", url: "https://example.com/" },
		],
	},
];

describe("parseBotLanes", () => {
	test("reads the sidecar lane list", () => {
		expect(
			parseBotLanes({
				lanes: [
					{
						agent_id: "agent-b",
						tabs: [{ id: "t1", title: "Inbox", url: "https://x.test/" }],
					},
				],
			})
		).toEqual([
			{
				agentId: "agent-b",
				tabs: [{ id: "t1", title: "Inbox", url: "https://x.test/" }],
			},
		]);
	});

	test("answers no lanes for an error or malformed reply", () => {
		expect(parseBotLanes({ ok: false, error: "forbidden" })).toEqual([]);
		expect(parseBotLanes({ lanes: [{ agent_id: "", tabs: [] }] })).toEqual([]);
		expect(parseBotLanes(null)).toEqual([]);
	});
});

describe("parseBotLiveFrame", () => {
	test("turns a frame into a JPEG data URL", () => {
		expect(
			parseBotLiveFrame({
				ok: true,
				frame: {
					captured_at: "2026-11-02T00:00:00.000Z",
					height: 720,
					image: "AAAA",
					mime: "image/jpeg",
					seq: 3,
					via: "screencast",
					width: 1280,
				},
			})
		).toEqual({
			capturedAt: "2026-11-02T00:00:00.000Z",
			height: 720,
			seq: 3,
			src: "data:image/jpeg;base64,AAAA",
			width: 1280,
		});
	});

	test("refuses a missing frame or another image type", () => {
		expect(parseBotLiveFrame({ ok: true, frame: null })).toBeNull();
		expect(
			parseBotLiveFrame({
				frame: {
					captured_at: "",
					height: 1,
					image: "PHN2Zz4=",
					mime: "image/svg+xml",
					seq: 1,
					width: 1,
				},
			})
		).toBeNull();
	});
});

describe("pickBotLaneTab", () => {
	test("keeps the watched tab while it is open", () => {
		const current = { agentId: "agent-b", tabId: "t2" };
		expect(pickBotLaneTab(lanes, current)).toBe(current);
	});

	test("moves to the first open tab when the watched one closed", () => {
		expect(
			pickBotLaneTab(lanes, { agentId: "agent-b", tabId: "gone" })
		).toEqual({ agentId: "agent-b", tabId: "t1" });
		expect(pickBotLaneTab(lanes, null)).toEqual({
			agentId: "agent-b",
			tabId: "t1",
		});
		expect(pickBotLaneTab([], null)).toBeNull();
	});
});

test("botLaneScreencastPath encodes the lane and tab", () => {
	expect(
		botLaneScreencastPath("/api/ext/@ryu/browser", {
			agentId: "agent/a",
			tabId: "t 1",
		})
	).toBe("/api/ext/@ryu/browser/lanes/agent%2Fa/tabs/t%201/screencast");
});
