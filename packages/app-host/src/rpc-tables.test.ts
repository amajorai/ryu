// Lockstep guard: the METHOD_CAPABILITY / GRANT_CAPABILITY / STREAMING_METHODS
// maps in `rpc.ts` are now DERIVED at module load from the blessed host-API table
// (`crates/ryu-kernel-contracts/schemas/host-api.json`). This test pins the derived
// shapes to the HISTORICAL hand-written tables (frozen below as fixtures) so the
// single-source refactor can never silently change the wire vocabulary.
//
// EXACT set-equality is enforced in BOTH directions per map — not just "every old
// key present". METHOD_CAPABILITY absence = deny (an unknown method is rejected),
// so a leaked EXTRA key would silently widen the dispatch surface; a missing key
// would break a shipping method. Either direction must fail this test.

import { describe, expect, test } from "bun:test";
import {
	type Capability,
	GRANT_CAPABILITY,
	HOST_API_VERSION,
	METHOD_CAPABILITY,
	STREAMING_METHODS,
} from "./rpc.ts";

// ── Frozen fixtures: the hand-written tables exactly as they were before the
//    single-source refactor (git HEAD~ of rpc.ts). Do NOT regenerate these from
//    the JSON — their whole job is to be an INDEPENDENT copy. ──────────────────

const OLD_METHOD_CAPABILITY: Record<string, Capability> = {
	"core.listAgents": "core.listAgents",
	"ui.registerRoute": "ui.render",
	"tool.call": "tool.call",
	"ui.sendMessage": "ui.sendMessage",
	"widget.setState": "widget.state",
	"widget.getGlobals": "widget.state",
	"ui.requestDisplayMode": "ui.displayMode",
	"ui.requestModal": "ui.displayMode",
	"ui.notifyHeight": "ui.displayMode",
	"ui.requestClose": "ui.displayMode",
	"ui.openExternal": "ui.displayMode",
	"ui.uploadFile": "ui.displayMode",
	"ui.selectFiles": "ui.displayMode",
	"ui.getFileDownloadUrl": "ui.displayMode",
	"ui.setOpenInAppUrl": "ui.displayMode",
	"model.complete": "model.complete",
	"agent.run": "agent.run",
	"storage.get": "storage.kv",
	"storage.set": "storage.kv",
	"storage.delete": "storage.kv",
	"storage.keys": "storage.kv",
	"agent.run.stream": "agent.run",
	"agent.cancel": "agent.run",
	"spaces.createDoc": "spaces.docs",
	"spaces.getDoc": "spaces.docs",
	"spaces.updateDoc": "spaces.docs",
	"spaces.listDocs": "spaces.docs",
	"spaces.deleteDoc": "spaces.docs",
	"media.image": "media.generate",
	"media.video": "media.generate",
	"media.tts": "media.generate",
	"media.transcribe": "media.transcribe",
	"registry.engineModels": "core.listAgents",
	"registry.ttsEngines": "core.listAgents",
	"registry.agents": "core.listAgents",
	"assets.searchGifs": "core.listAgents",
	"finetune.capability": "finetune.runs",
	"finetune.start": "finetune.runs",
	"finetune.list": "finetune.runs",
	"finetune.get": "finetune.runs",
	"finetune.cancel": "finetune.runs",
	"finetune.adapters": "finetune.runs",
	"finetune.merge": "finetune.runs",
	"finetune.stream": "finetune.runs",
	"monitors.list": "monitors.crud",
	"monitors.get": "monitors.crud",
	"monitors.create": "monitors.crud",
	"monitors.update": "monitors.crud",
	"monitors.delete": "monitors.crud",
	"monitors.run": "monitors.crud",
	"monitors.snapshots": "monitors.crud",
	"monitors.alerts": "monitors.crud",
	"workflows.list": "workflows.crud",
	"workflows.get": "workflows.crud",
	"workflows.save": "workflows.crud",
	"workflows.delete": "workflows.crud",
	"workflows.versionsList": "workflows.crud",
	"workflows.versionGet": "workflows.crud",
	"workflows.versionCreate": "workflows.crud",
	"workflows.versionRestore": "workflows.crud",
	"workflows.templatesList": "workflows.crud",
	"workflows.templateGet": "workflows.crud",
	"workflows.templateInstall": "workflows.crud",
	"workflows.webhook": "workflows.crud",
	"workflows.run": "workflows.runstate",
	"workflows.runGet": "workflows.runstate",
	"workflows.resume": "workflows.runstate",
	"workflows.agents": "workflows.catalogs",
	"workflows.apps": "workflows.catalogs",
	"workflows.mcp": "workflows.catalogs",
	"workflows.skills": "workflows.catalogs",
	"workflows.schedules": "workflows.catalogs",
	"workflows.composio": "workflows.catalogs",
	"ghost.recordStart": "ghost.record",
	"ghost.recordStatus": "ghost.record",
	"ghost.recordStop": "ghost.record",
	"ghost.recipes": "ghost.record",
	"webhooks.list": "webhooks.crud",
	"webhooks.ingressStatus": "webhooks.crud",
	"quests.list": "quests.crud",
	"quests.create": "quests.crud",
	"quests.update": "quests.crud",
	"quests.delete": "quests.crud",
	"quests.complete": "quests.crud",
	"quests.dismiss": "quests.crud",
	"quests.acceptSuggestion": "quests.crud",
	"quests.dismissSuggestion": "quests.crud",
	"quests.judge": "quests.crud",
	"quests.openDetectionSettings": "quests.crud",
	"activity.list": "activity.read",
	"activity.openSession": "activity.read",
	"timeline.list": "timeline.read",
	"timeline.journal": "timeline.read",
	"timeline.frame": "timeline.read",
	"timeline.openReview": "timeline.read",
	"timeline.openSettings": "timeline.read",
	"mail.list": "mail.crud",
	"mail.messages": "mail.crud",
	"mail.create": "mail.crud",
	"mail.delete": "mail.crud",
	"mail.rotateSecret": "mail.crud",
	"mail.send": "mail.crud",
	"mail.inboundUrl": "mail.crud",
	"calendar.jobs": "calendar.crud",
	"calendar.workflows": "calendar.crud",
	"calendar.agents": "calendar.crud",
	"calendar.createAutomation": "calendar.crud",
	"learning.config": "learning.crud",
	"learning.experience": "learning.crud",
	"learning.healing": "learning.crud",
	"approvals.list": "approvals.crud",
	"approvals.approve": "approvals.crud",
	"approvals.reject": "approvals.crud",
	"notifications.list": "approvals.crud",
	"notifications.markRead": "approvals.crud",
	"notifications.ack": "approvals.crud",
	"suggestions.list": "approvals.crud",
	"suggestions.feedback": "approvals.crud",
	"suggestions.openInChat": "approvals.crud",
	"meetings.list": "meetings.crud",
	"meetings.transcript": "meetings.crud",
	"meetings.start": "meetings.crud",
	"meetings.finalize": "meetings.crud",
	"meetings.delete": "meetings.crud",
	"meetings.rename": "meetings.crud",
	"meetings.import": "meetings.crud",
	"meetings.open": "meetings.crud",
	"meetings.openNotes": "meetings.crud",
	"meetings.openList": "meetings.crud",
	"skills.getSource": "skills.crud",
	"skills.create": "skills.crud",
	"skills.update": "skills.crud",
	"skills.listVersions": "skills.crud",
	"skills.versionSource": "skills.crud",
	"skills.snapshot": "skills.crud",
	"skills.restore": "skills.crud",
	"skills.setTitle": "skills.crud",
	"shell.openTab": "shell.integrate",
	"shell.themeSubscribe": "shell.integrate",
	"shell.registerCommand": "shell.integrate",
	"shell.eventsSubscribe": "shell.integrate",
};

const OLD_GRANT_CAPABILITY: Record<string, Capability> = {
	"core:list_agents": "core.listAgents",
	"ui:render": "ui.render",
	"tool:call": "tool.call",
	"ui:send_message": "ui.sendMessage",
	"hook:side-model": "model.complete",
	"hook:run-agent": "agent.run",
	"storage:kv": "storage.kv",
	"spaces:docs": "spaces.docs",
	"media:generate": "media.generate",
	"media:transcribe": "media.transcribe",
	"finetune:runs": "finetune.runs",
	"monitors:crud": "monitors.crud",
	"workflows:crud": "workflows.crud",
	"workflows:runstate": "workflows.runstate",
	"workflows:catalogs": "workflows.catalogs",
	"ghost:record": "ghost.record",
	"webhooks:crud": "webhooks.crud",
	"quests:crud": "quests.crud",
	"activity:read": "activity.read",
	"timeline:read": "timeline.read",
	"mail:crud": "mail.crud",
	"calendar:crud": "calendar.crud",
	"learning:crud": "learning.crud",
	"approvals:crud": "approvals.crud",
	"meetings:crud": "meetings.crud",
	"skills:crud": "skills.crud",
	"shell:integrate": "shell.integrate",
};

const OLD_STREAMING_METHODS: readonly string[] = [
	"agent.run.stream",
	"finetune.stream",
	"shell.themeSubscribe",
	"shell.registerCommand",
	"shell.eventsSubscribe",
];

/** Pure comparison (no assertions): the sorted key lists plus the list of keys
 *  whose capability differs between the derived map and the frozen fixture. The
 *  test asserts on these so every `expect` stays inside a `test()` block. */
function diffMap(
	derived: Record<string, Capability>,
	fixture: Record<string, Capability>
): {
	derivedKeys: string[];
	fixtureKeys: string[];
	valueMismatches: string[];
} {
	const derivedKeys = Object.keys(derived).sort();
	const fixtureKeys = Object.keys(fixture).sort();
	const valueMismatches = fixtureKeys.filter(
		(key) => derived[key] !== fixture[key]
	);
	return { derivedKeys, fixtureKeys, valueMismatches };
}

describe("rpc tables derive from the blessed host-API contract (lockstep)", () => {
	test("METHOD_CAPABILITY equals the frozen hand-written table", () => {
		const { derivedKeys, fixtureKeys, valueMismatches } = diffMap(
			METHOD_CAPABILITY,
			OLD_METHOD_CAPABILITY
		);
		// Both directions: identical key SET (no leaked extras, no drops) …
		expect(derivedKeys).toEqual(fixtureKeys);
		// … and identical capability per key.
		expect(valueMismatches).toEqual([]);
	});

	test("GRANT_CAPABILITY equals the frozen hand-written table", () => {
		const { derivedKeys, fixtureKeys, valueMismatches } = diffMap(
			GRANT_CAPABILITY,
			OLD_GRANT_CAPABILITY
		);
		expect(derivedKeys).toEqual(fixtureKeys);
		expect(valueMismatches).toEqual([]);
	});

	test("STREAMING_METHODS equals the frozen hand-written set", () => {
		expect([...STREAMING_METHODS].sort()).toEqual(
			[...OLD_STREAMING_METHODS].sort()
		);
	});

	test("view.action (Rust-bridge-only) never leaks into the TS tables", () => {
		// It carries `tsHost: false` in the table, so the derivation must skip it:
		// absent from METHOD_CAPABILITY, and its grant absent from GRANT_CAPABILITY.
		expect(METHOD_CAPABILITY["view.action"]).toBeUndefined();
		expect(GRANT_CAPABILITY["views:actions"]).toBeUndefined();
	});

	test("the contract version is a non-empty semver-shaped string", () => {
		expect(typeof HOST_API_VERSION).toBe("string");
		expect(HOST_API_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});
