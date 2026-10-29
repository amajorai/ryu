import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentSyncProfile } from "@/src/lib/api/agent-sync.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const profiles: Array<{
	resolve: (value: { profiles: AgentSyncProfile[] }) => void;
	reject: (error: Error) => void;
}> = [];
let listThreadCalls = 0;
let importThreadCalls = 0;
const onImported = mock(() => undefined);
const { useAutoThreadImport } = await import("./useAutoThreadImport.ts");
const target = {
	url: "https://fixture.example",
	token: null,
	fetch: async (input: RequestInfo | URL) => {
		const pathname = new URL(
			input instanceof Request ? input.url : String(input)
		).pathname;
		if (pathname === "/api/agent-sync/profiles") {
			const result = await new Promise<{
				profiles: AgentSyncProfile[];
			}>((resolve, reject) => profiles.push({ resolve, reject }));
			return Response.json(result);
		}
		if (pathname.endsWith("/threads/import")) {
			importThreadCalls += 1;
			return Response.json({
				already_imported: false,
				conversation_id: "conversation-1",
				title: "Imported",
				message_count: 1,
			});
		}
		if (pathname.endsWith("/threads")) {
			listThreadCalls += 1;
			return Response.json({
				supported: true,
				engine: "codex",
				threads: [
					{
						id: "thread-1",
						engine: "codex",
						title: "Thread",
						message_count: 1,
						updated_at: 1000,
					},
				],
			});
		}
		throw new Error(`Unexpected transport request: ${pathname}`);
	},
};
const transport = spyOn(globalThis, "fetch").mockImplementation(
	Object.assign(target.fetch, { preconnect: globalThis.fetch.preconnect })
);
afterAll(() => transport.mockRestore());
function agentSummary(id: string, engine: string): AgentSummary {
	return {
		id,
		engine,
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: true,
		createdAt: null,
		description: null,
		installed: true,
		installHint: null,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: false,
		model: null,
		name: id,
		recommended: false,
		safetyProfile: "approval_required",
		systemPrompt: null,
		title: "",
		transport: "acp",
		version: null,
		versionStatus: null,
	};
}
function Harness({
	agents = [agentSummary("codex", "codex")],
}: {
	agents?: AgentSummary[];
}) {
	useAutoThreadImport({ agents, target, onImported });
	return null;
}
let root = createRoot(document.createElement("div"));
let now = 100_000;
const date = spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => date.mockRestore());
async function focus() {
	now += 31_000;
	await act(async () => {
		window.dispatchEvent(new Event("focus"));
	});
}
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	profiles.length = 0;
	listThreadCalls = 0;
	importThreadCalls = 0;
	onImported.mockClear();
	localStorage.clear();
});

test("focus events cannot overlap a slow sync-profile read or duplicate imports", async () => {
	await act(async () => root.render(<Harness />));
	await focus();
	await focus();
	expect(profiles).toHaveLength(1);
	await act(async () => profiles[0].resolve({ profiles: [] }));
	expect(listThreadCalls).toBe(1);
	expect(importThreadCalls).toBe(1);
	expect(onImported).toHaveBeenCalledTimes(1);
	await focus();
	expect(profiles).toHaveLength(2);
	await act(async () => profiles[1].resolve({ profiles: [] }));
	expect(importThreadCalls).toBe(1);
});

test("an empty roster does not request sync profiles", async () => {
	await act(async () => root.render(<Harness agents={[]} />));
	await focus();
	expect(profiles).toHaveLength(0);
	expect(listThreadCalls).toBe(0);
});

test("a failed profile read releases the scan gate and retains legacy import", async () => {
	await act(async () => root.render(<Harness />));
	await focus();
	await act(async () => profiles[0].reject(new Error("offline")));
	expect(importThreadCalls).toBe(1);
	await focus();
	expect(profiles).toHaveLength(2);
});

test("unmount during the profile read prevents follow-up work", async () => {
	await act(async () => root.render(<Harness />));
	await focus();
	await act(async () => root.render(null));
	await act(async () => profiles[0].resolve({ profiles: [] }));
	expect(listThreadCalls).toBe(0);
	expect(importThreadCalls).toBe(0);
	expect(onImported).not.toHaveBeenCalled();
});

test("Core-managed engines skip native history without persisting a redundant seen set", async () => {
	await act(async () => root.render(<Harness />));
	await focus();
	await act(async () =>
		profiles[0].resolve({
			profiles: [
				{
					provider: "codex",
					importEnabled: true,
					exportEnabled: false,
					id: "sync-codex",
					root: "/fixture/codex",
					status: "idle",
					conflictCount: 0,
					lastOperationId: null,
					updatedAt: 1000,
				},
			],
		})
	);
	expect(listThreadCalls).toBe(0);
	expect(localStorage.getItem("ryu:auto-imported-thread-ids")).toBeNull();
	await focus();
	expect(profiles).toHaveLength(2);
});

test("disabled import and unsupported engines perform no reads", async () => {
	localStorage.setItem("ryu:auto-import-agent-threads", "false");
	await act(async () => root.render(<Harness />));
	await focus();
	expect(profiles).toHaveLength(0);
	localStorage.removeItem("ryu:auto-import-agent-threads");
	await act(async () =>
		root.render(<Harness agents={[agentSummary("local", "local")]} />)
	);
	await focus();
	expect(profiles).toHaveLength(0);
});
