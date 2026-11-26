import { expect, test } from "bun:test";
import {
	servedShellEventChannels,
	shellEventSignal,
} from "./shell-event-gate.ts";

const EVERY_CHANNEL = [
	"activity",
	"notifications",
	"quests",
	"monitors",
	"approvals",
	"downloads",
	"navigation",
];

test("the shell grant alone is served no channel", () => {
	expect(servedShellEventChannels(EVERY_CHANNEL, ["shell:integrate"])).toEqual(
		[]
	);
	expect(servedShellEventChannels(EVERY_CHANNEL, [])).toEqual([]);
});

test("each feed grant opens its own channels and no other", () => {
	expect(
		servedShellEventChannels(EVERY_CHANNEL, [
			"shell:integrate",
			"activity:read",
		])
	).toEqual(["activity"]);
	expect(servedShellEventChannels(EVERY_CHANNEL, ["approvals:crud"])).toEqual([
		"approvals",
		"notifications",
	]);
	expect(servedShellEventChannels(EVERY_CHANNEL, ["monitors:crud"])).toEqual([
		"monitors",
	]);
});

test("downloads, quests and navigation are served under no grant", () => {
	const everyGrant = [
		"shell:integrate",
		"activity:read",
		"approvals:crud",
		"monitors:crud",
		"quests:crud",
		"downloads:read",
		"app:download",
	];
	expect(servedShellEventChannels(EVERY_CHANNEL, everyGrant)).toEqual([
		"activity",
		"approvals",
		"notifications",
		"monitors",
	]);
	expect(
		servedShellEventChannels(["downloads", "quests", "navigation"], everyGrant)
	).toEqual([]);
});

test("only requested channels are served, and a near match of a grant opens nothing", () => {
	expect(
		servedShellEventChannels(["approvals"], ["activity:read", "approvals:crud"])
	).toEqual(["approvals"]);
	expect(servedShellEventChannels([], ["activity:read"])).toEqual([]);
	expect(
		servedShellEventChannels(["Activity", "activity "], ["activity:read"])
	).toEqual([]);
	expect(
		servedShellEventChannels(EVERY_CHANNEL, [
			"activity:read:all",
			"activity",
			"approvals:read",
			"monitors:CRUD",
		])
	).toEqual([]);
});

test("an event leaves the host as a signal that names the channel only", () => {
	const text = shellEventSignal({
		channel: "approvals",
		data: {
			type: "created",
			request: { title: "fixture-title", question: "fixture-question" },
		},
	});
	expect(JSON.parse(text)).toEqual({ channel: "approvals" });
	expect(text).not.toContain("fixture");
	expect(shellEventSignal({ channel: "activity", data: null })).toBe(
		'{"channel":"activity"}'
	);
});
