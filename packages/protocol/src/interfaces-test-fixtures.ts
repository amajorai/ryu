import { join } from "node:path";
import {
	agentActs,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "./interfaces.ts";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	usefulStateFixture,
} from "./interfaces-fixture.ts";

export function thread(
	overrides: Partial<InterfaceThread> & { id: string }
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: null,
		messageCount: 1,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: overrides.id,
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

export const snapshot: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "",
			id: "ryu",
			name: "Ryu",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "",
			id: "coder",
			name: "Coder",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "",
			id: "quiet",
			name: "Quiet",
			status: "idle",
		},
	],
	groups: [
		{
			id: "t1",
			kind: "team",
			memberAgentIds: ["ryu", "coder"],
			name: "Launch Crew",
		},
		{ id: "p1", kind: "project", memberAgentIds: [], name: "Website" },
	],
	threads: [
		thread({
			agentIds: ["ryu"],
			id: "a",
			messageCount: 4,
			updatedAt: "2026-10-03T00:00:00.000Z",
		}),
		thread({
			agentIds: ["coder"],
			id: "b",
			projectId: "p1",
			running: true,
			updatedAt: "2026-10-02T00:00:00.000Z",
		}),
		thread({
			agentIds: ["ryu", "coder"],
			id: "c",
			teamId: "t1",
			updatedAt: "2026-10-04T00:00:00.000Z",
		}),
		thread({ id: "d", pinned: true, updatedAt: "2026-09-01T00:00:00.000Z" }),
	],
	version: 1,
};

// src → packages/protocol → packages → repo root.
export const REPO_ROOT = join(import.meta.dir, "../../..");
export const RUST_MANIFEST_PATH = join(
	REPO_ROOT,
	"crates/core/kernel-contracts/src/manifest.rs"
);
export const RUST_SERVER_PATH = join(
	REPO_ROOT,
	"apps/core/src/server/app_lifecycle/plugin_collect.rs"
);

// ---------------------------------------------------------------------------
// Useful state (spec docs/interfaces-useful-state.md §2.1, §7.2)
// ---------------------------------------------------------------------------

export const NOW = FIXTURE_NOW_MS;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const at = (ms: number) => new Date(ms).toISOString();

export function actsOf(
	fixture: InterfaceSnapshot = usefulStateFixture(),
	nowMs = NOW
): Map<string, InterfaceAgentAct> {
	return agentActs(fixture, nowMs, FIXTURE_CLOCK);
}

export function actOf(
	acts: Map<string, InterfaceAgentAct>,
	id: string
): InterfaceAgentAct {
	const found = acts.get(id);
	if (!found) {
		throw new Error(`no act for ${id}`);
	}
	return found;
}

export function askOf(fixture: InterfaceSnapshot, id: string): InterfaceAsk {
	const found = fixture.asks?.find((ask) => ask.id === id);
	if (!found) {
		throw new Error(`no ask ${id}`);
	}
	return found;
}

export function makeAsk(
	overrides: Partial<InterfaceAsk> & { id: string }
): InterfaceAsk {
	return {
		agentId: null,
		blocking: true,
		kind: "approval",
		since: null,
		source: "approvals",
		text: overrides.id,
		threadId: null,
		...overrides,
	};
}

export function miniSnapshot(
	agentIds: string[],
	threads: InterfaceThread[],
	asks: InterfaceAsk[] = []
): InterfaceSnapshot {
	return {
		agents: agentIds.map((id) => ({
			avatarUrl: null,
			description: "",
			id,
			name: id.toUpperCase(),
			status: "idle",
		})),
		asks,
		groups: [],
		threads,
		version: 1,
	};
}

/** Replace one thread of the fixture. */
export function withThread(
	fixture: InterfaceSnapshot,
	id: string,
	patch: Partial<InterfaceThread>
): InterfaceSnapshot {
	return {
		...fixture,
		threads: fixture.threads.map((item) =>
			item.id === id ? { ...item, ...patch } : item
		),
	};
}
