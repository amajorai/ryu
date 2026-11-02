import { expect, test } from "bun:test";
import {
	type StartupChoiceWriters,
	saveStartupChoices,
} from "./save-startup-choices.ts";

function recordingWriters(failNodeSave: boolean) {
	const calls: string[] = [];
	const writers: StartupChoiceWriters = {
		saveDefaultNode: (name) => {
			calls.push(`node:${name}`);
			return failNodeSave
				? Promise.reject(new Error("Node file is read-only"))
				: Promise.resolve();
		},
		setStartupDefaultAccountId: (userId) => {
			calls.push(`default-account:${userId}`);
		},
		setStartupDefaultNodeName: (name) => {
			calls.push(`default-node:${name}`);
		},
		switchAccount: (userId) => {
			calls.push(`switch:${userId}`);
			return Promise.resolve();
		},
	};
	return { calls, writers };
}

const choices = {
	accountToActivate: "user-two",
	defaultAccountId: "user-two",
	defaultNodeName: "Studio Mac",
	nodeName: "Studio Mac",
};

test("a failed node save rejects before the account switch or any default", async () => {
	const { calls, writers } = recordingWriters(true);
	await expect(saveStartupChoices(choices, writers)).rejects.toThrow(
		"Node file is read-only"
	);
	expect(calls).toEqual(["node:Studio Mac"]);
});

test("the account switch, which reloads the window, is committed last", async () => {
	const { calls, writers } = recordingWriters(false);
	await saveStartupChoices(choices, writers);
	expect(calls).toEqual([
		"node:Studio Mac",
		"default-account:user-two",
		"default-node:Studio Mac",
		"switch:user-two",
	]);
});

test("skipped steps leave their defaults untouched", async () => {
	const { calls, writers } = recordingWriters(false);
	await saveStartupChoices(
		{ accountToActivate: null, nodeName: "local" },
		writers
	);
	expect(calls).toEqual(["node:local"]);
});
