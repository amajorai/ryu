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
	CodedRpcError,
	dispatchRpc,
	GRANT_CAPABILITY,
	HOST_API_VERSION,
	type HostServices,
	METHOD_CAPABILITY,
	STREAMING_METHODS,
} from "./rpc.ts";

test("registers targeted Inbox notifications as a separate capability", () => {
	expect(METHOD_CAPABILITY["notifications.send"]).toBe("notifications.send");
	expect(GRANT_CAPABILITY["notifications:send-to-user"]).toBe(
		"notifications.send"
	);
});

// ── Frozen fixtures: the hand-written tables exactly as they were before the
//    single-source refactor (git HEAD~ of rpc.ts). Do NOT regenerate these from
//    the JSON — their whole job is to be an INDEPENDENT copy. ──────────────────

const OLD_METHOD_CAPABILITY: Record<string, Capability> = {
	"host.capabilities": "host.capabilities",
	"i18n.get": "i18n",
	"i18n.translate": "i18n",
	"i18n.subscribe": "i18n",
	"node.shareOrigins": "node.shareOrigins",
	"native.haptics": "native.haptics",
	"native.notifications.create": "native.notifications",
	"native.liveActivities.update": "native.liveActivities",
	"app.request": "app.http",
	"realtime.connect": "app.realtime",
	"realtime.publish": "app.realtime",
	"realtime.presence": "app.realtime",
	"realtime.subscribe": "app.realtime",
	"realtime.close": "app.realtime",
	"core.listAgents": "core.listAgents",
	"catalog.snapshot": "core.listAgents",
	"catalog.models": "core.listAgents",
	"chat.list": "chat.broadcast",
	"chat.send": "chat.broadcast",
	"ui.registerRoute": "ui.render",
	"tool.call": "tool.call",
	"ui.sendMessage": "ui.sendMessage",
	"ui.toast.show": "ui.toast",
	"ui.toast.update": "ui.toast",
	"ui.toast.dismiss": "ui.toast",
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
	"storage.compareAndSet": "storage.kv",
	// Added deliberately with the sealing primitive: all three share ONE
	// capability so a grant covers seal+open+status as a unit — an app that can
	// seal must be able to open, or it writes data it can never read back.
	"crypto.seal": "crypto.seal",
	"crypto.open": "crypto.seal",
	"crypto.status": "crypto.seal",
	"agent.run.stream": "agent.run",
	"agent.cancel": "agent.run",
	"spaces.ensureSpace": "spaces.docs",
	"spaces.createDoc": "spaces.docs",
	"spaces.getDoc": "spaces.docs",
	"spaces.updateDoc": "spaces.docs",
	"spaces.listDocs": "spaces.docs",
	"spaces.deleteDoc": "spaces.docs",
	"spaces.search": "spaces.docs",
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
	"workflows.notifyTargets": "workflows.catalogs",
	"workflows.composio": "workflows.catalogs",
	"workflows.hookEvents": "workflows.catalogs",
	"ghost.recordStart": "ghost.record",
	"ghost.recordStatus": "ghost.record",
	"ghost.recordStop": "ghost.record",
	"ghost.recipes": "ghost.record",
	"webhooks.list": "webhooks.crud",
	"webhooks.ingressStatus": "webhooks.crud",
	"webhooks.secretGet": "webhooks.crud",
	"webhooks.secretSet": "webhooks.crud",
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
	"quests.capture": "quests.capture",
	"quests.use": "quests.crud",
	"quests.pin": "quests.crud",
	"quests.scratchpad": "quests.crud",
	"quests.setScratchpad": "quests.crud",
	"activity.list": "activity.read",
	"activity.openSession": "activity.read",
	"background.list": "background.control",
	"background.stop": "background.control",
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
	"warmup.detect": "warmup.crud",
	"warmup.list": "warmup.crud",
	"warmup.apply": "warmup.crud",
	"warmup.runNow": "warmup.crud",
	"learning.config": "learning.crud",
	"learning.experience": "learning.crud",
	"learning.healing": "learning.crud",
	"approvals.list": "approvals.crud",
	"approvals.approve": "approvals.crud",
	"approvals.reject": "approvals.crud",
	"notifications.list": "approvals.crud",
	"notifications.markRead": "approvals.crud",
	"notifications.ack": "approvals.crud",
	"notifications.send": "notifications.send",
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
	// Outpost is THREE rows, not one per sidecar endpoint: `social.request` is a
	// generic forwarder onto the app's `/api/social` public mount, and the two
	// navigation verbs cannot be forwarded.
	"social.request": "social.crud",
	"social.open": "social.crud",
	"social.openList": "social.crud",
	// Automated Reasoning is ONE row for the same reason Outpost's forwarder is:
	// `reasoning.request` fronts the whole `/api/reasoning` public mount, and the
	// companion has no navigation verb to add — it never opens a shell tab.
	"reasoning.request": "reasoning.check",
	"safeActions.request": "safe-actions.manage",
	// Deep Read, same one-forwarder shape: `rlm.request` fronts the whole `/api/rlm`
	// public mount and the companion has no navigation verb.
	"rlm.request": "rlm.query",
	// `tuition.request` and `news.request` front the whole `/api/tuition` and
	// `/api/news` public mounts, for the same reason: one forwarder rather than a verb
	// per route, so a route added to either manifest costs no host change.
	"tuition.request": "tuition.crud",
	"news.request": "news.crud",
	// `subtitles.request` fronts the whole `/api/subtitles` public mount, same shape
	// again: pick a video, poll the job, read the cues, download the file.
	"subtitles.request": "subtitles.crud",
	// Blueprint is ONE row for the same reason again: `blueprint.request` fronts the
	// whole `/api/blueprint` public mount — plans, revisions, annotations, the verdict
	// — and the review companion has no navigation verb, because the review surface IS
	// the companion.
	"blueprint.request": "blueprint.review",
	"skills.getSource": "skills.crud",
	"skills.create": "skills.crud",
	"skills.update": "skills.crud",
	"skills.listVersions": "skills.crud",
	"skills.versionSource": "skills.crud",
	"skills.snapshot": "skills.crud",
	"skills.restore": "skills.crud",
	"skills.distribute": "skills.crud",
	"skills.setTitle": "skills.crud",
	"shell.openTab": "shell.integrate",
	"shell.themeSubscribe": "shell.integrate",
	// Host display preferences (the "Friendly names" toggle today). Same capability
	// and same grant as the theme stream it sits beside: both are read-only reads of
	// how the shell is currently presenting itself, neither reaches user data.
	"shell.prefsSubscribe": "shell.integrate",
	"shell.registerCommand": "shell.integrate",
	"shell.registerTabIcon": "shell.integrate",
	"shell.eventsSubscribe": "shell.integrate",
	// Assistant bridge — added deliberately, not regenerated: an app publishes
	// page context to the one global "Ask Ryu" surface and may take it over while
	// its own page is open. One capability for the whole family.
	"assistant.publishContext": "assistant.context",
	"assistant.clearContext": "assistant.context",
	"assistant.registerSurface": "assistant.context",
	"assistant.clearSurface": "assistant.context",
	"assistant.open": "assistant.context",
};

const OLD_GRANT_CAPABILITY: Record<string, Capability> = {
	"native:haptics": "native.haptics",
	"native:notifications": "native.notifications",
	"native:live_activities": "native.liveActivities",
	"app:http": "app.http",
	"app:realtime": "app.realtime",
	"core:list_agents": "core.listAgents",
	"chat.sendFollowUp": "chat.broadcast",
	"ui:render": "ui.render",
	"tool:call": "tool.call",
	"ui:send_message": "ui.sendMessage",
	"ui:toast": "ui.toast",
	"hook:side-model": "model.complete",
	"hook:run-agent": "agent.run",
	"storage:kv": "storage.kv",
	"crypto:seal": "crypto.seal",
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
	"quests:capture": "quests.capture",
	"activity:read": "activity.read",
	"background:control": "background.control",
	"timeline:read": "timeline.read",
	"mail:crud": "mail.crud",
	"calendar:crud": "calendar.crud",
	"warmup:crud": "warmup.crud",
	"learning:crud": "learning.crud",
	"approvals:crud": "approvals.crud",
	"notifications:send-to-user": "notifications.send",
	"meetings:crud": "meetings.crud",
	"social:crud": "social.crud",
	"reasoning:check": "reasoning.check",
	"safe-actions:manage": "safe-actions.manage",
	"rlm:query": "rlm.query",
	"tuition:crud": "tuition.crud",
	"news:crud": "news.crud",
	"subtitles:crud": "subtitles.crud",
	"blueprint:review": "blueprint.review",
	"skills:crud": "skills.crud",
	"shell:integrate": "shell.integrate",
	"assistant:context": "assistant.context",
};

const OLD_STREAMING_METHODS: readonly string[] = [
	"agent.run.stream",
	"finetune.stream",
	"i18n.subscribe",
	"shell.themeSubscribe",
	"shell.prefsSubscribe",
	"shell.registerCommand",
	"shell.registerTabIcon",
	"shell.eventsSubscribe",
	"realtime.subscribe",
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

describe("skills.distribute RPC", () => {
	const granted = new Set<Capability>(["skills.crud"]);

	test("forwards an existing skill id to the host service", async () => {
		const received: string[] = [];
		const services: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
			skillsDistribute: ({ id }) => {
				received.push(id);
				return Promise.resolve();
			},
		};

		await expect(
			dispatchRpc("skills.distribute", [{ id: "skill-42" }], granted, services)
		).resolves.toBeNull();
		expect(received).toEqual(["skill-42"]);
	});

	for (const input of [{}, { id: 42 }]) {
		test(`rejects ${JSON.stringify(input)} before it reaches the host service`, async () => {
			let called = false;
			const services: HostServices = {
				listAgents: () => Promise.resolve([]),
				registerRoute: () => Promise.resolve(null),
				skillsDistribute: () => {
					called = true;
					return Promise.resolve();
				},
			};

			const error = await dispatchRpc(
				"skills.distribute",
				[input],
				granted,
				services
			).catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(CodedRpcError);
			expect((error as CodedRpcError).code).toBe("invalid_args");
			expect(called).toBe(false);
		});
	}
});

describe("i18n RPC", () => {
	const granted = new Set<Capability>();

	test("translates with the host runtime and an explicit fallback", async () => {
		const received: unknown[] = [];
		const services: HostServices = {
			i18nTranslate: (input) => {
				received.push(input);
				return "localized";
			},
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
		};

		await expect(
			dispatchRpc(
				"i18n.translate",
				[
					{
						defaultMessage: "Hello {name}",
						id: "example.greeting",
						values: { name: "Ryu" },
					},
				],
				granted,
				services
			)
		).resolves.toBe("localized");
		expect(received).toEqual([
			{
				defaultMessage: "Hello {name}",
				id: "example.greeting",
				values: { name: "Ryu" },
			},
		]);
	});

	test("rejects non-primitive interpolation values before the host runs", async () => {
		let called = false;
		const services: HostServices = {
			i18nTranslate: () => {
				called = true;
				return "should not run";
			},
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve(null),
		};

		const error = await dispatchRpc(
			"i18n.translate",
			[
				{
					defaultMessage: "Hello",
					id: "example.greeting",
					values: { name: { secret: "no" } },
				},
			],
			granted,
			services
		).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(CodedRpcError);
		expect((error as CodedRpcError).code).toBe("invalid_args");
		expect(called).toBe(false);
	});
});
