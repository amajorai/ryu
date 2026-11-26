import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type Judgement,
	judgeOpenMethods,
	readDesktopServices,
	scanServiceSource,
} from "./__tests__/host-direct-scan.ts";
import { DEFAULT_GRANT_ALLOWLIST } from "./default-grant-allowlist.ts";

// Class guard for "the host serves an app directly". A host method that needs
// no grant, or a grant the Gateway approves for any app id, must reach the node
// in one of three ways: through Core's host bridge with the plugin id (Core
// checks the app), without leaving the host, or with a reply the dispatcher
// parses through the allowlist helper (allowlist-projection.ts). Any other
// method fails this test by name until it has a row below.
//
// The scanner reads source text, see __tests__/host-direct-scan.ts for what it
// can tell apart. It does NOT see: a fetch inside a helper that takes no node
// argument and comes from a module the scanner lists as local, the native host
// and the other desktop hosts, the owner-scoped grant rule, and whether a
// listed field is harmless.
//
// Rows. "open" is a finding that is not fixed yet, with its id from the
// security sweep of 21 Nov 2026. A fix PR removes its row, or moves it to
// "accepted" with the reason when the method stays host-direct by design.
// "accepted" is judged outside the class. Security read the host-side body of
// each such service on 21 Nov 2026 at 8978943e09 and ran nothing. Core's side
// of each route and the grant of each method were not read. Numbers in
// brackets are rows of that sweep's list of host methods.
// "unseen" is a method whose service this scanner cannot read at all.
//
// Rows after the fix PRs of that sweep met this guard on one branch (23 Nov
// 2026). Each change was read in the source, not by Security, and nothing ran.
// - spaces.search (HD-3 / RB-3) has no row: #1369 made it a bridge call.
// - blueprint.request and rlm.request (RB-6) have no row: #1364 took
//   blueprint:review and rlm:query off the default list, so not every app can
//   hold them. Both services are still direct calls for the reviewed holders.
// - ghost.recordStart, recordStatus and recordStop (HD-1) moved from "open" to
//   "unseen", and ui.openExternal (RB-4) is new under "accepted"; see the rows.
// - chat.list (#1368), shell.eventsSubscribe (#1367) and the quests family
//   (#1377) were changed by their fix PRs and are still direct calls. Their
//   rows stay "open" until Security reads each fix and moves it to "accepted".
const ROOT = join(import.meta.dir, "../../..");

interface Row {
	kind: "accepted" | "open" | "unseen";
	methods: string[];
	note: string;
}

const QUESTS = [
	"acceptSuggestion",
	"capture",
	"complete",
	"create",
	"delete",
	"dismiss",
	"dismissSuggestion",
	"judge",
	"list",
	"pin",
	"scratchpad",
	"setScratchpad",
	"update",
	"use",
].map((verb) => `quests.${verb}`);
const REALTIME = ["close", "connect", "presence", "publish", "subscribe"].map(
	(verb) => `realtime.${verb}`
);

const ROWS: Row[] = [
	{
		kind: "open",
		note: "RB-5 follow-up",
		methods: ["workflows.connectBindings"],
	},
	{ kind: "open", note: "SA-6", methods: ["chat.list"] },
	{ kind: "open", note: "SA-2", methods: ["shell.eventsSubscribe"] },
	{ kind: "open", note: "HD-2", methods: QUESTS },
	{
		kind: "open",
		note: "SA-16: the caller rule is the id prefix @ryu/ alone, not Core's first_party; update of an enabled app not traced",
		methods: ["apps.installBundle"],
	},
	{
		kind: "open",
		note: "no id yet: the engine catalogs pass as the desktop client maps them, mapper not traced (9 to 11)",
		methods: [
			"media.ttsEngines",
			"registry.engineModels",
			"registry.ttsEngines",
		],
	},
	{
		kind: "open",
		note: "no id yet: what it returns was not traced (83)",
		methods: ["node.shareOrigins"],
	},
	{
		kind: "open",
		note: "no id yet: Core realtime with the app id; Core's room check was not traced (147 to 151)",
		methods: REALTIME,
	},
	{
		kind: "accepted",
		note: "accepted, host side read by Security 21 Nov: the service builds its own projection (13, 14, 82, 84)",
		methods: [
			"assets.searchGifs",
			"assets.searchImages",
			"core.listAgents",
			"registry.agents",
		],
	},
	{
		kind: "accepted",
		note: "accepted, host side read by Security 21 Nov: returns only the result of the app's own request (5, 6)",
		methods: ["media.transcribe", "media.tts"],
	},
	{
		kind: "accepted",
		note: "accepted, host side read by Security 21 Nov: only files the person picks in the host's picker; the reply carries the node's address and the id of the Uploads Space (8)",
		methods: ["ui.uploadFile"],
	},
	{
		kind: "accepted",
		note: "accepted, host side read by Security 21 Nov: the app's own sidecar, another app's only with the per-target grant; the body of resolveAppRequestTarget was not read (146)",
		methods: ["app.request"],
	},
	{
		kind: "accepted",
		note: "accepted, read at the merge of #1375 (RB-4), not by Security: needs no grant and does not reach the node; the scanner calls it direct because of askOpenExternal, the shell's own prompt, a context field it does not list as local; the Tauri opener runs only after the person says yes, with the address the prompt showed",
		methods: ["ui.openExternal"],
	},
	{
		kind: "unseen",
		note: "added by the createI18nHostServices spread, local strings (65 to 67)",
		methods: ["i18n.get", "i18n.subscribe", "i18n.translate"],
	},
	{
		kind: "unseen",
		note: "added by the createCompanionMediaServices spread: model.complete is a bridge call there, the media calls send the app id when the app has a media permission (1 to 4)",
		methods: ["media.audio", "media.image", "media.video", "model.complete"],
	},
	{
		kind: "unseen",
		note: "added by the ghostRecipesViaAppMount spread, forwarded to the Recipes app's list route, not judged (57)",
		methods: ["ghost.recipes"],
	},
	{
		kind: "unseen",
		note: "HD-1, added by the gateGhostRecording spread since #1365: refused, and the node is not asked, unless the caller is @ryu/workflows or @ryu/recipes by exact id and compiled into Core; for those two still a direct call with the owner's node token; ghost:record is still on the default list",
		methods: ["ghost.recordStart", "ghost.recordStatus", "ghost.recordStop"],
	},
	{
		kind: "unseen",
		note: "ends the caller's own agent.run stream inside ExtensionHost, no dispatcher arm",
		methods: ["agent.cancel"],
	},
	{
		kind: "unseen",
		note: "no desktop builder serves it; the host that does was not read",
		methods: [
			"host.capabilities",
			"native.haptics",
			"native.liveActivities.update",
			"native.notifications.create",
			"storage.compareAndSet",
			"ui.notifyHeight",
			"ui.requestDisplayMode",
			"ui.requestModal",
			"widget.setState",
		],
	},
];

/** What the scanner must say about a method for its row to be true. */
const EXPECTED: Record<Row["kind"], Judgement["state"]> = {
	accepted: "direct",
	open: "direct",
	unseen: "unseen",
};

const STAND_IN = [
	'import { toTarget } from "@/src/lib/api/client.ts";',
	'import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";',
	'import { fetchRows } from "@/src/lib/api/rows.ts";',
	'import { getLocalHistory } from "@/src/lib/api/shadow.ts";',
	"export function buildStandIn({",
	"\tcompanion,",
	"\tnode,",
	"\topenTab,",
	"\tsessionRef,",
	"}: PluginHostServicesContext): Partial<HostServices> {",
	"\treturn {",
	"\t\tviaBridge: (input) =>",
	'\t\t\tpluginHostInvoke(toTarget(node), companion.pluginId, "x.y", input),',
	"\t\t// A comment that names fetchRows(toTarget(node)) changes nothing.",
	'\t\tinsideTheHost: () => openTab("/x"),',
	"\t\thostDirect: () => fetchRows(toTarget(node)),",
	"\t\tnoNodeArgument: getLocalHistory,",
	"\t\tbridgeAndMore: async (input) => {",
	'\t\t\tawait pluginHostInvoke(toTarget(node), companion.pluginId, "x.y", input);',
	"\t\t\treturn fetchRows(toTarget(node));",
	"\t\t},",
	"\t\tthroughContext: () => sessionRef.current.send(),",
	"\t\t...spreadHelper(node),",
	"\t};",
	"}",
].join("\n");

describe("host methods any app can call", () => {
	// Read inside a test, so a source the scanner refuses fails a named test.
	let scan: Map<string, Judgement> | undefined;
	const judged = () => {
		scan ??= judgeOpenMethods(ROOT, DEFAULT_GRANT_ALLOWLIST);
		return scan;
	};
	const listed = ROWS.flatMap((row) => row.methods);

	test("a NEW host-direct method on such a grant fails here by name", () => {
		const rows = new Set(listed);
		const unlisted = [...judged()]
			.filter(([method, verdict]) => {
				const safe =
					verdict.state === "covered" || verdict.state === "projected";
				return !(safe || rows.has(method));
			})
			.map(
				([method, verdict]) => `${method} is ${verdict.state}, ${verdict.why}`
			);
		expect(unlisted).toEqual([]);
	});

	test("no row is stale", () => {
		// A row is stale when its method is gone, its grant left the default
		// list, or its service changed kind (for example it moved to the bridge,
		// or the dispatcher now filters it). Remove the row, or fix its kind.
		const stale = ROWS.flatMap((row) =>
			row.methods
				.filter((method) => judged().get(method)?.state !== EXPECTED[row.kind])
				.map((method) => {
					const now = judged().get(method)?.state ?? "not callable by any app";
					return `${method} (${row.kind}, ${row.note}) is now ${now}`;
				})
		);
		expect(stale).toEqual([]);
	});

	test("each method has one row", () => {
		expect(listed).toHaveLength(new Set(listed).size);
	});

	test("the catalogs closed by the allowlist helper need no row", () => {
		const projected = [...judged()]
			.filter(([, verdict]) => verdict.state === "projected")
			.map(([method]) => method);
		// More may follow; these eight must stay filtered in the dispatcher.
		expect(projected).toEqual(
			expect.arrayContaining([
				"workflows.agents",
				"workflows.apps",
				"workflows.composio",
				"workflows.hookEvents",
				"workflows.mcp",
				"workflows.notifyTargets",
				"workflows.schedules",
				"workflows.skills",
			])
		);
	});

	test("a spread in a builder is one the rows know", () => {
		// A spread adds service keys the scanner cannot read. A new one fails
		// here until its methods have rows.
		const spreads = [...readDesktopServices(ROOT).spreads.keys()].sort();
		expect(spreads).toEqual([
			"createCompanionMediaServices",
			"createI18nHostServices",
			"finetuneServicesViaAppRequest",
			// #1365: wraps the three ghost.record services, see their row.
			"gateGhostRecording",
			"ghostRecipesViaAppMount",
		]);
	});
});

describe("the scanner", () => {
	test("tells the bridge, the host itself and a direct call apart", () => {
		const { properties, spreads } = scanServiceSource("stand-in.ts", STAND_IN);
		const kinds = Object.fromEntries(
			[...properties].map(([key, property]) => [key, property.kind])
		);
		expect(kinds).toEqual({
			bridgeAndMore: "direct",
			hostDirect: "direct",
			insideTheHost: "local",
			noNodeArgument: "direct",
			throughContext: "direct",
			viaBridge: "bridge",
		});
		expect(properties.get("hostDirect")?.evidence).toEqual([
			"node",
			"fetchRows",
		]);
		expect([...spreads.keys()]).toEqual(["spreadHelper"]);
	});

	test("refuses a builder it cannot read", () => {
		const odd = STAND_IN.replace("\t\thostDirect:", "\t\t[computed]:");
		expect(() => scanServiceSource("stand-in.ts", odd)).toThrow(
			"cannot read the line"
		);
	});
});
