import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
// Tests for the app-vs-plugin classification the `ryu` CLI exposes (cli/kind.ts)
// and its two consumers, `ryu list` and `ryu catalog`.
//
// Two invariants are load-bearing here and each has a test that fails loudly if it
// regresses: (1) the DEFAULT is "all", because both commands have always printed
// apps and plugins together — narrowing the default would silently drop rows from
// scripts that predate `--kind`; (2) the predicate matches Core's `is_app` and the
// desktop's split (explicit `type`, else a Companion runnable/kind), so a row is
// labelled the same in the terminal as it is in the Store.
//
// The HTTP layer is the injected CoreApi fake, so nothing hits a node.

import { expect, test } from "bun:test";
import type {
	AppInfo,
	AppRecord,
	CatalogEntry,
} from "@ryuhq/core-client/plugins";
import { runCli } from "../cli/dispatch.ts";
import {
	catalogEntryKind,
	installedAppKind,
	parseKindFilter,
} from "../cli/kind.ts";
import { type CliIO, type CoreApi, UsageError } from "../cli/types.ts";

// ── Fixtures + fakes ──────────────────────────────────────────────────────────

interface CapturedCliIO {
	err: () => string;
	io: CliIO;
	out: () => string;
}
interface ClassifiedCatalogFixture extends CatalogEntry {
	type: "app" | "plugin";
}
const classifiedIdOutputFields = z.array(z.looseObject({ id: z.string() }));
const classifiedIdOutputObservationSchema = z.custom<
	z.infer<typeof classifiedIdOutputFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		classifiedIdOutputFields.safeParse(value).success
);
function makeIo(): CapturedCliIO {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: (s) => {
				errBuf += s;
			},
		},
		out: () => outBuf,
		err: () => errBuf,
	};
}

const baseApp: AppInfo = {
	builtIn: false,
	commands: [],
	companion: null,
	enabled: true,
	id: "base",
	installed: true,
	installedVersion: "1.0.0",
	localOnly: false,
	name: "Base",
	permissionGrants: [],
	requires: null,
	runnables: [],
	sidecarName: null,
	targets: [],
	surfaceSupport: [],
	version: "1.0.0",
	windowsFirst: false,
};

/** Installed APP: ships a Companion runnable (the full-page UI surface). */
const installedApp: AppInfo = {
	...baseApp,
	id: "whiteboard",
	name: "Whiteboard",
	companion: { label: "Whiteboard", icon: null, shortcut: null },
	runnables: [
		{ config: null, id: "ui", kind: "companion", name: "Whiteboard" },
	],
};

/** Installed PLUGIN: tool-only, no Companion. */
const installedPlugin: AppInfo = {
	...baseApp,
	id: "advisor",
	name: "Advisor",
	runnables: [{ config: null, id: "ask", kind: "tool", name: "Ask" }],
};

const baseEntry: CatalogEntry = {
	built_in: false,
	description: "",
	id: "base",
	kinds: [],
	name: "Base",
	permission_grants: [],
	source: "registry",
	tags: [],
	version: "1.0.0",
};

/** Catalog APP with Core's explicit `type` discriminator (the modern wire). Core
 *  does not declare `type` on core-client's CatalogEntry yet, so it is attached
 *  the same way the wire delivers it — as an extra field on the JSON object. */
const catalogApp = {
	...baseEntry,
	id: "whiteboard",
	name: "Whiteboard",
	description: "A collaborative whiteboard",
	kinds: ["companion"],
	tags: ["draw"],
	type: "app",
} satisfies ClassifiedCatalogFixture;

/** Catalog PLUGIN, also explicitly typed. */
const catalogPlugin = {
	...baseEntry,
	id: "advisor",
	name: "Advisor",
	description: "A second-opinion tool",
	kinds: ["tool"],
	tags: ["review"],
	type: "plugin",
} satisfies ClassifiedCatalogFixture;

const sampleRecord: AppRecord = {
	approvedGrants: [],
	createdAt: null,
	enabled: false,
	id: "advisor",
	updatedAt: null,
	version: "1.0.0",
};

/** A CoreApi whose every method rejects — override just the one under test. */
function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: () =>
			Promise.reject(new Error("unexpected execAppCommand call")),
		streamChat: () => Promise.reject(new Error("unexpected streamChat call")),
		...overrides,
	};
}

const bothApps = () => Promise.resolve([installedApp, installedPlugin]);
const bothEntries = () => Promise.resolve([catalogApp, catalogPlugin]);

// ── the predicate itself ──────────────────────────────────────────────────────

test("catalogEntryKind prefers Core's explicit type discriminator", () => {
	expect(catalogEntryKind(catalogApp)).toBe("app");
	expect(catalogEntryKind(catalogPlugin)).toBe("plugin");
	// An explicit "plugin" wins even when the legacy kinds say companion — the
	// same precedence the desktop/marketplace helper applies.
	const conflicted = {
		...baseEntry,
		kinds: ["companion"],
		type: "plugin",
	} satisfies ClassifiedCatalogFixture;
	expect(catalogEntryKind(conflicted)).toBe("plugin");
});

test("catalogEntryKind falls back to kinds on a wire with no type", () => {
	expect(catalogEntryKind({ ...baseEntry, kinds: ["companion", "tool"] })).toBe(
		"app"
	);
	expect(catalogEntryKind({ ...baseEntry, kinds: ["tool"] })).toBe("plugin");
	expect(catalogEntryKind(baseEntry)).toBe("plugin");
});

test("installedAppKind reads the manifest runnables (AppInfo has no kinds)", () => {
	expect(installedAppKind(installedApp)).toBe("app");
	expect(installedAppKind(installedPlugin)).toBe("plugin");
	expect(installedAppKind(baseApp)).toBe("plugin");
});

test("parseKindFilter: unset is 'all'; a bad value is a usage error", () => {
	expect(parseKindFilter(null)).toBe("all");
	expect(parseKindFilter("app")).toBe("app");
	expect(parseKindFilter("plugin")).toBe("plugin");
	expect(parseKindFilter("all")).toBe("all");
	expect(() => parseKindFilter("apps")).toThrow(UsageError);
});

// ── list ──────────────────────────────────────────────────────────────────────

test("list: default shows BOTH apps and plugins (the no-break-scripts default)", async () => {
	const cap = makeIo();
	const code = await runCli(["list"], {
		io: cap.io,
		api: stubApi({ fetchApps: bothApps }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("whiteboard");
	expect(cap.out()).toContain("advisor");
});

test("list: the table carries a KIND column labelling each row", async () => {
	const cap = makeIo();
	await runCli(["list"], { io: cap.io, api: stubApi({ fetchApps: bothApps }) });
	const lines = cap.out().trim().split("\n");
	expect(lines[0]).toContain("KIND");
	expect(lines.find((l) => l.startsWith("whiteboard"))).toContain("app");
	expect(lines.find((l) => l.startsWith("advisor"))).toContain("plugin");
});

test("list --kind app: only apps", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--kind", "app"], {
		io: cap.io,
		api: stubApi({ fetchApps: bothApps }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("whiteboard");
	expect(cap.out()).not.toContain("advisor");
});

test("list --kind=plugin: inline form, only plugins", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--kind=plugin"], {
		io: cap.io,
		api: stubApi({ fetchApps: bothApps }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("advisor");
	expect(cap.out()).not.toContain("whiteboard");
});

test("list --kind app --json: the filter applies to the machine output too", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--kind", "app", "--json"], {
		io: cap.io,
		api: stubApi({ fetchApps: bothApps }),
	});
	expect(code).toBe(0);
	const parsed = classifiedIdOutputObservationSchema.parse(
		JSON.parse(cap.out())
	);
	expect(parsed.map((a) => a.id)).toEqual(["whiteboard"]);
});

test("list: an empty filtered result names what was asked for", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--kind", "app"], {
		io: cap.io,
		api: stubApi({ fetchApps: () => Promise.resolve([installedPlugin]) }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("No apps installed.");
});

test("list --kind <bogus> is a usage error (exit 2), never a silent 'all'", async () => {
	const cap = makeIo();
	const code = await runCli(["list", "--kind", "apps"], {
		io: cap.io,
		api: stubApi({ fetchApps: bothApps }),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Unknown --kind 'apps'");
	expect(cap.err()).toContain("app, plugin, all");
});

// ── catalog / search ──────────────────────────────────────────────────────────

test("catalog: lists apps AND plugins with a KIND column", async () => {
	const cap = makeIo();
	const code = await runCli(["catalog"], {
		io: cap.io,
		api: stubApi({ fetchAppsCatalog: bothEntries }),
	});
	expect(code).toBe(0);
	const lines = cap.out().trim().split("\n");
	expect(lines[0]).toContain("KIND");
	expect(lines.find((l) => l.startsWith("whiteboard"))).toContain("app");
	expect(lines.find((l) => l.startsWith("advisor"))).toContain("plugin");
});

test("catalog --kind plugin: plugins are discoverable on their own", async () => {
	const cap = makeIo();
	const code = await runCli(["catalog", "--kind", "plugin"], {
		io: cap.io,
		api: stubApi({ fetchAppsCatalog: bothEntries }),
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("advisor");
	expect(cap.out()).not.toContain("whiteboard");
});

test("search <query> --kind: the query and the kind filter compose", async () => {
	const cap = makeIo();
	const code = await runCli(["search", "draw", "--kind", "plugin"], {
		io: cap.io,
		api: stubApi({ fetchAppsCatalog: bothEntries }),
	});
	expect(code).toBe(0);
	// "draw" matches the whiteboard's tag, but it is an app — so nothing survives.
	expect(cap.out()).toContain("No matching plugins.");
});

test("catalog --kind app --json: filtered entries, unreshaped", async () => {
	const cap = makeIo();
	const code = await runCli(["catalog", "--kind", "app", "--json"], {
		io: cap.io,
		api: stubApi({ fetchAppsCatalog: bothEntries }),
	});
	expect(code).toBe(0);
	const parsed = classifiedIdOutputObservationSchema.parse(
		JSON.parse(cap.out())
	);
	expect(parsed.map((e) => e.id)).toEqual(["whiteboard"]);
});

// ── one lifecycle path for both ───────────────────────────────────────────────

test("add <plugin id> uses the SAME installApp route as an app id", async () => {
	const cap = makeIo();
	let installed = "";
	const code = await runCli(["add", "advisor"], {
		io: cap.io,
		api: stubApi({
			installApp: (_t, id) => {
				installed = id;
				return Promise.resolve(sampleRecord);
			},
		}),
	});
	expect(code).toBe(0);
	expect(installed).toBe("advisor");
	expect(cap.out()).toContain("Installed advisor");
});

test("help documents --kind and that both kinds share the id-based commands", async () => {
	const cap = makeIo();
	await runCli(["--help"], { io: cap.io, api: stubApi() });
	expect(cap.out()).toContain("--kind <k>");
	expect(cap.out()).toContain("apps and plugins");
});
