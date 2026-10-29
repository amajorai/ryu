import { describe, expect, test } from "bun:test";
import {
	compareAsks,
	type InterfaceSnapshot,
	redactSnapshot,
} from "./interfaces.ts";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_ARGUMENT_SECRET,
	FIXTURE_ASK_IDS,
	FIXTURE_NOW_MS,
	FIXTURE_PRIVATE_STRINGS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./interfaces-fixture.ts";

/** Every string anywhere in the snapshot (values only). */
function stringsOf(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			stringsOf(item, out);
		}
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) {
			stringsOf(item, out);
		}
	}
	return out;
}

function leaks(snapshot: InterfaceSnapshot): string[] {
	const strings = stringsOf(snapshot);
	return FIXTURE_PRIVATE_STRINGS.filter((secret) =>
		strings.some((value) => value.includes(secret))
	);
}

describe("usefulStateFixture", () => {
	test("default shape", () => {
		const fixture = usefulStateFixture();
		expect(fixture.version).toBe(1);
		expect(fixture.agents.map((agent) => agent.id)).toEqual(
			Object.values(FIXTURE_AGENT_IDS)
		);
		expect(fixture.observedAt).toBe("2026-10-16T10:00:00.000Z");
		expect(fixture.privacy).toBe("full");
		expect(fixture.askBlindSpots).toEqual(["permission", "input", "question"]);
		expect(
			[...(fixture.asks ?? [])]
				.filter((ask) => ask.blocking)
				.sort(compareAsks)
				.map((ask) => ask.id)
		).toEqual([
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		const ada = fixture.asks?.find(
			(ask) => ask.id === FIXTURE_ASK_IDS.adaToolCall
		);
		expect(ada).toMatchObject({
			blocking: true,
			holdsRun: false,
			riskTags: ["run"],
			subject: "tool_call",
			target: "deploy.sh",
		});
		expect(
			ada?.choices?.find((choice) => choice.id === "approve")?.destructive
		).toBe(true);
		const io = fixture.threads.find(
			(thread) => thread.id === FIXTURE_THREAD_IDS.io
		);
		expect(io?.routineRun).toEqual({
			firedAt: "2026-10-16T09:45:00.000Z",
			jobId: "job-login",
		});
		expect(io?.runStartedAt).toBe("2026-10-16T09:45:20.000Z");
	});

	test("times move with nowMs", () => {
		const later = usefulStateFixture({ nowMs: FIXTURE_NOW_MS + 60_000 });
		expect(later.observedAt).toBe("2026-10-16T10:01:00.000Z");
	});

	test("never carries approval arguments", () => {
		for (const variant of [
			usefulStateFixture(),
			usefulStateFixture({ livePermission: true }),
			usefulStateFixture({ privacy: "redacted" }),
		]) {
			expect(JSON.stringify(variant)).not.toContain(FIXTURE_ARGUMENT_SECRET);
			expect(JSON.stringify(variant)).not.toContain("TOKEN");
		}
	});

	test("the agents filter keeps only their threads, asks and events", () => {
		const fixture = usefulStateFixture({ agents: ["ada", "io"] });
		expect(fixture.agents.map((agent) => agent.id)).toEqual(["ada", "io"]);
		expect(fixture.threads.map((thread) => thread.id)).toEqual([
			FIXTURE_THREAD_IDS.ada,
			FIXTURE_THREAD_IDS.io,
		]);
		expect(fixture.asks?.map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(fixture.events?.every((event) => event.agentId === "io")).toBe(true);
		expect(fixture.account?.transactions).toEqual([]);
	});

	test("filtering to every agent keeps the whole fixture, workflow gate included", () => {
		const all = usefulStateFixture({
			agents: Object.values(FIXTURE_AGENT_IDS),
		});
		expect(all.asks?.map((ask) => ask.id)).toEqual(
			usefulStateFixture().asks?.map((ask) => ask.id)
		);
	});

	test("livePermission makes Ada run with a permission ask", () => {
		const fixture = usefulStateFixture({ livePermission: true });
		const thread = fixture.threads.find(
			(item) => item.id === FIXTURE_THREAD_IDS.ada
		);
		expect(thread?.running).toBe(true);
		expect(fixture.agents.find((agent) => agent.id === "ada")?.status).toBe(
			"working"
		);
		const permission = fixture.asks?.find(
			(ask) => ask.id === FIXTURE_ASK_IDS.adaPermission
		);
		expect(permission).toMatchObject({
			blocking: true,
			expiresApprox: true,
			expiresAt: "2026-10-16T10:03:00.000Z",
			holdsRun: true,
			since: "2026-10-16T09:53:00.000Z",
			sinceApprox: true,
			source: "live-tab",
			subject: "edit",
			target: "deploy.sh",
			text: "Allow Edit deploy.sh?",
		});
		expect(permission?.choices).toEqual([
			{
				destructive: true,
				id: "allow_once",
				label: "Allow once",
				tone: "allow",
			},
			{ id: "reject_once", label: "Reject", tone: "deny" },
		]);
		expect(
			usefulStateFixture().asks?.some((ask) => ask.kind === "permission")
		).toBe(false);
	});

	test("the full fixture holds the private strings the redaction test looks for", () => {
		// Renderers strip backticks, so the list also holds the plain form.
		const strings = stringsOf(usefulStateFixture({ livePermission: true })).map(
			(value) => value.replaceAll("`", "")
		);
		const missing = FIXTURE_PRIVATE_STRINGS.filter(
			(secret) =>
				!strings.some((value) => value.includes(secret.replaceAll("`", "")))
		);
		expect(missing).toEqual([]);
	});

	test("the redacted fixture contains no fixture content", () => {
		const redacted = usefulStateFixture({
			livePermission: true,
			privacy: "redacted",
		});
		expect(leaks(redacted)).toEqual([]);
		expect(redacted.privacy).toBe("redacted");
		// Ids, kinds, times, risk tags, schedule phrases and window names stay.
		const ada = redacted.asks?.find(
			(ask) => ask.id === FIXTURE_ASK_IDS.adaToolCall
		);
		expect(ada).toMatchObject({
			kind: "approval",
			reason: null,
			riskTags: ["run"],
			since: "2026-10-16T09:46:00.000Z",
			target: null,
			text: "Needs approval",
		});
		expect(ada?.choices).toBeUndefined();
		expect(redacted.events?.every((event) => event.title === "Routine")).toBe(
			true
		);
		expect(
			redacted.events?.some((event) => event.label === "Daily at 9:45 AM")
		).toBe(true);
		expect(
			redacted.agents.find((agent) => agent.id === "fa")?.limit?.label
		).toBe("Weekly");
		expect(redacted.groups.map((group) => group.name)).toEqual([
			"Team",
			"Project",
		]);
		const di = redacted.threads.find(
			(thread) => thread.id === FIXTURE_THREAD_IDS.di
		);
		expect(di?.blocker).toMatchObject({ detail: null, title: "Failed" });
		const cy = redacted.threads.find(
			(thread) => thread.id === FIXTURE_THREAD_IDS.cy
		);
		expect(cy?.activity?.label).toBe("Editing");
		expect(cy?.helpers?.titles).toEqual([]);
		expect(cy?.progress).toMatchObject({
			current: null,
			done: 3,
			next: null,
			total: 7,
		});
	});

	test("redaction is idempotent", () => {
		const once = usefulStateFixture({ privacy: "redacted" });
		expect(redactSnapshot(once)).toEqual(once);
	});
});
