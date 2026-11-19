// Shared fixtures and fakes for the `ryu-cli` dispatcher tests
// (cli.dispatch*.test.ts). The HTTP layer is mocked via an injected CoreApi,
// so nothing hits a Core node.

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type {
	AppInfo,
	AppRecord,
	CatalogEntry,
} from "@ryuhq/core-client/plugins";
import { z } from "zod";
import type { CliIO, CoreApi } from "../cli/types.ts";

// These are test observations, not full publisher DTOs. Each admits the
// entire native JSON tree and preserves the raw root/future fields before
// checking the exact fields asserted below.
const auditOutputFields = z.looseObject({ reachable: z.boolean() });
const appListOutputFields = z.array(z.looseObject({ id: z.string() }));
const errorOutputFields = z.looseObject({ error: z.string() });
const chatOutputFields = z.looseObject({ text: z.string() });
export const auditOutputObservation = z.custom<
	z.infer<typeof auditOutputFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		auditOutputFields.safeParse(value).success
);
export const appListOutputObservation = z.custom<
	z.infer<typeof appListOutputFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		appListOutputFields.safeParse(value).success
);
export const errorOutputObservation = z.custom<
	z.infer<typeof errorOutputFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		errorOutputFields.safeParse(value).success
);
export const chatOutputObservation = z.custom<z.infer<typeof chatOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		chatOutputFields.safeParse(value).success
);
type CoreCall = NonNullable<CoreApi["call"]>;
export interface CapturedResourceCall {
	body?: NonNullable<Parameters<CoreCall>[2]>["body"];
	method?: NonNullable<Parameters<CoreCall>[2]>["method"];
	path?: Parameters<CoreCall>[1];
}
type PreviewCall = NonNullable<CoreApi["previewAppLifecycle"]>;
export interface PreviewCallCapture {
	value: CapturedPreviewCall | null;
}
export interface CapturedPreviewCall {
	action: Parameters<PreviewCall>[2];
	id: Parameters<PreviewCall>[1];
}

// ── Fixtures + fakes ──────────────────────────────────────────────────────────

export function makeIo() {
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
		} satisfies CliIO,
		out: () => outBuf,
		err: () => errBuf,
	};
}

export const sampleApp: AppInfo = {
	builtIn: false,
	commands: [],
	companion: null,
	enabled: true,
	id: "whiteboard",
	installed: true,
	installedVersion: "1.0.0",
	localOnly: false,
	name: "Whiteboard",
	permissionGrants: [],
	requires: null,
	runnables: [],
	sidecarName: null,
	targets: [],
	surfaceSupport: [],
	version: "1.0.0",
	windowsFirst: false,
};

/** A cli-only app contributing `ryu mail <cmd>` subcommands. */
export const mailApp: AppInfo = {
	...sampleApp,
	id: "mail-contributor",
	name: "Mail",
	commands: [
		{
			name: "status",
			method: "GET",
			path: "/status",
			summary: "Show inbox status",
		},
		{ name: "send", method: "POST", path: "/send", summary: null },
	],
};

export const sampleCatalogEntry: CatalogEntry = {
	built_in: false,
	description: "A collaborative whiteboard",
	id: "whiteboard",
	kinds: ["companion"],
	name: "Whiteboard",
	permission_grants: [],
	source: "registry",
	tags: ["draw"],
	version: "1.0.0",
};

export const sampleRecord: AppRecord = {
	approvedGrants: [],
	createdAt: null,
	enabled: false,
	id: "whiteboard",
	updatedAt: null,
	version: "1.0.0",
};

/** A CoreApi whose every method rejects; override just the one under test. */
export function stubApi(overrides: Partial<CoreApi> = {}): CoreApi {
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
