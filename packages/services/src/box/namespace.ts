// packages/services/src/box/namespace.ts
//
// `ryu.box`: `@ryuhq/client`'s Box client arranged as resource namespaces,
// plus `run()` (create, wait until ready, exec; see ./helpers.ts):
//
//   ryu.box.{list,get,create,delete,stop,resume,fork,waitUntilReady}  Boxes
//   ryu.box.{run,exec,execStream}                                     commands
//   ryu.box.{accessToken,openTerminal,openTunnel,enableSsh}            sockets
//   ryu.box.{usage,limits}()                                           metering
//   ryu.box.processes.{list,get,spawn,logs,followLogs,kill,writeStdin,interrupt}
//   ryu.box.files.{list,read,readText,write,mkdir,delete,downloadArchive,
//                  uploadArchive}
//   ryu.box.previews.{list,create,delete}
//   ryu.box.snapshots.{list,get,create,delete}
//   ryu.box.secrets.{list,set,delete}
//   ryu.box.prompts.{list,get,create,cancel}
//   ryu.box.events.{list,follow}
//
// The rule: Boxes are the primary resource, so a call on a Box itself (its
// lifecycle, running a command in it, opening a socket to it) and the
// tenant-wide `usage()` and `limits()` stay at the top level. A call on something a Box
// holds (processes, files, previews, prompt runs, events) or on a tenant
// resource beside Boxes (snapshots, secrets) lives under that resource's
// namespace, as `list`/`get`/`create`/`delete` plus the resource's own verbs
// (`spawn`, `kill`, `cancel`, `set`). Removal is always `delete`, as on the
// other services (`files.delete` removes a file or directory).
//
// Streaming verbs: `follow` (`events.follow`, `processes.followLogs`) replays
// the retained log after an `after` cursor and then tails it, the same
// contract and name as `ryu.managedAgents.sessions.follow` and the wire's
// `?follow=true`. `ryu.notify.events.stream` is named differently on purpose:
// it is a live SSE feed of new items with no replay cursor. `followLogs`
// keeps its noun because it is the following form of `processes.logs` (one
// page of retained output): the namespace holds the processes, not their
// output, so a bare `processes.follow` would read as following the process
// list.
//
// Type note: `BoxNamespace` does not extend the `BoxAPI` class (its private
// members would make every alias and namespace part of that class's nominal
// type), so `ryu.box` is not assignable to `BoxAPI`. The top-level members are
// picked from `BoxAPI`, so they keep the client's signatures and JSDoc.
//
// The flat BoxAPI names (`listFiles`, `readTextFile`, `snapshot`,
// `putSecret`, ...) still work and make the same request; they are
// deprecated aliases of the canonical spelling in
// {@link BOX_CANONICAL_METHODS}. Three flat names are also the name of a
// namespace (`processes`, `prompts`, `events`): those namespaces are
// callable, so `ryu.box.processes(boxId)` still lists the processes.
// BoxAPI methods added later come through under their flat names until they
// get a canonical home (a test fails until they do).
//
// HTTP goes through the fetch shim in `throw` mode, so every non-2xx answer
// is a RyuError carrying the Box `error.code` (`quota_exceeded` is a
// RyuQuotaExceededError and is never retried).
//
// The client already sends an Idempotency-Key on `create` and `fork`; the
// shim keeps it for every retry unless the caller supplies one with
// `.with({ idempotencyKey })`. Terminal, tunnel and SSH sockets
// (`openTerminal`, `openTunnel`, the SSH proxy) use the client's `webSocket`
// option and bypass the shim: only the access-token request before them is
// shimmed, so they get no retries, timeouts or error mapping once open.
//
// `exec` is the plain command route: the service answers only once the
// command has ended, so the call's `timeoutMs` (default 60 s) must cover the
// command. Use `.with({ timeoutMs })` or `execStream` for longer commands;
// `run()` uses the stream.

import { type BoxAPI, createBoxClient, type RyuFetch } from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import type { RyuResult, SAFE_VIEW, Safe } from "../result.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	type BoxRun,
	type BoxRunDeps,
	type BoxRunInput,
	type BoxRunOptions,
	runBox,
	withSignal,
} from "./helpers.ts";
import { BOX_ROUTES } from "./routes.ts";

export type { BoxRun, BoxRunInput, BoxRunOptions } from "./helpers.ts";

/**
 * Each canonical `ryu.box.<resource>.<verb>` path and the BoxAPI method it
 * calls. The flat name of every entry is a deprecated alias that makes the
 * same request.
 */
export const BOX_CANONICAL_METHODS = {
	"processes.list": "processes",
	"processes.get": "process",
	"processes.spawn": "spawn",
	"processes.logs": "logs",
	"processes.followLogs": "followLogs",
	"processes.kill": "kill",
	"processes.writeStdin": "writeStdin",
	"processes.interrupt": "interrupt",
	"files.list": "listFiles",
	"files.read": "readFile",
	"files.readText": "readTextFile",
	"files.write": "writeFile",
	"files.mkdir": "makeDirectory",
	"files.delete": "removePath",
	"files.downloadArchive": "downloadArchive",
	"files.uploadArchive": "uploadArchive",
	"previews.list": "listPreviews",
	"previews.create": "createPreview",
	"previews.delete": "deletePreview",
	"snapshots.list": "listSnapshots",
	"snapshots.get": "getSnapshot",
	"snapshots.create": "snapshot",
	"snapshots.delete": "deleteSnapshot",
	"secrets.list": "listSecrets",
	"secrets.set": "putSecret",
	"secrets.delete": "deleteSecret",
	"prompts.list": "prompts",
	"prompts.get": "promptRun",
	"prompts.create": "prompt",
	"prompts.cancel": "cancelPrompt",
	"events.list": "events",
	"events.follow": "followEvents",
} as const satisfies Readonly<Record<string, keyof BoxAPI>>;

/** BoxAPI methods that stay at the top level of `ryu.box` under their own name. */
export const BOX_TOP_LEVEL_METHODS = [
	"list",
	"get",
	"create",
	"delete",
	"stop",
	"resume",
	"fork",
	"waitUntilReady",
	"exec",
	"execStream",
	"accessToken",
	"openTerminal",
	"openTunnel",
	"enableSsh",
	"usage",
	"limits",
] as const satisfies readonly (keyof BoxAPI)[];

/**
 * `ryu.box.processes`. Calling it directly is the deprecated flat
 * `processes(boxId)`.
 */
export interface BoxProcessesNamespace {
	/** Replays retained output, then follows the process until it exits. */
	followLogs: BoxAPI["followLogs"];
	/** One process. */
	get: BoxAPI["process"];
	/** Kills every process the service is running in the Box; resolves to how many. */
	interrupt: BoxAPI["interrupt"];
	/** Kills one process. */
	kill: BoxAPI["kill"];
	/** Every process the service started in the Box. */
	list: BoxAPI["processes"];
	/** A process's retained output after sequence number `after`. */
	logs: BoxAPI["logs"];
	/** Starts a background process and returns at once. */
	spawn: BoxAPI["spawn"];
	/** Writes to a process's stdin, optionally closing it. */
	writeStdin: BoxAPI["writeStdin"];
	/** @deprecated Use `ryu.box.processes.list(boxId)`. */
	(...args: Parameters<BoxAPI["processes"]>): ReturnType<BoxAPI["processes"]>;
}

/** `ryu.box.files`. Paths are relative to /workspace unless absolute. */
export interface BoxFilesNamespace {
	/** Removes a file or directory. */
	delete: BoxAPI["removePath"];
	/** Streams a tar archive of a path. */
	downloadArchive: BoxAPI["downloadArchive"];
	/** Lists a directory. */
	list: BoxAPI["listFiles"];
	/** Creates a directory. */
	mkdir: BoxAPI["makeDirectory"];
	/** A file's bytes. */
	read: BoxAPI["readFile"];
	/** A file decoded as UTF-8. */
	readText: BoxAPI["readTextFile"];
	/** Extracts a tar archive into a path. */
	uploadArchive: BoxAPI["uploadArchive"];
	/** Creates or replaces a file with bytes or text. */
	write: BoxAPI["writeFile"];
}

/** `ryu.box.previews`: ports published at a preview URL. */
export interface BoxPreviewsNamespace {
	/** Publishes a port. Private previews need the API key. */
	create: BoxAPI["createPreview"];
	/** Removes a preview by its token. */
	delete: BoxAPI["deletePreview"];
	/** A Box's previews. */
	list: BoxAPI["listPreviews"];
}

/** `ryu.box.snapshots`: the tenant's filesystem snapshots. */
export interface BoxSnapshotsNamespace {
	/** Snapshots a Box's filesystem, optionally under a name. */
	create: BoxAPI["snapshot"];
	/** Deletes a snapshot by id or name. */
	delete: BoxAPI["deleteSnapshot"];
	/** One snapshot by id or name. */
	get: BoxAPI["getSnapshot"];
	/** Every snapshot. */
	list: BoxAPI["listSnapshots"];
}

/** `ryu.box.secrets`: encrypted tenant secrets that Boxes opt into by name. */
export interface BoxSecretsNamespace {
	/** Deletes a secret. */
	delete: BoxAPI["deleteSecret"];
	/** The secrets' names and when each was last set (never their values). */
	list: BoxAPI["listSecrets"];
	/** Creates or replaces a secret. */
	set: BoxAPI["putSecret"];
}

/**
 * `ryu.box.prompts`: coding-agent prompt runs. Calling it directly is the
 * deprecated flat `prompts(boxId, limit?)`.
 */
export interface BoxPromptsNamespace {
	/** Cancels an active managed run; a finished run is returned unchanged. */
	cancel: BoxAPI["cancelPrompt"];
	/** Queues a prompt run (`managed` in the Box, or `worker` for an external worker). */
	create: BoxAPI["prompt"];
	/** One run, including its result once it finishes. */
	get: BoxAPI["promptRun"];
	/** A Box's recent runs. */
	list: BoxAPI["prompts"];
	/** @deprecated Use `ryu.box.prompts.list(boxId, limit?)`. */
	(...args: Parameters<BoxAPI["prompts"]>): ReturnType<BoxAPI["prompts"]>;
}

/**
 * `ryu.box.events`: a Box's event log. Calling it directly is the
 * deprecated flat `events(boxId, limit?)`.
 */
export interface BoxEventsNamespace {
	/** Follows the event log from `after` until `signal` aborts. */
	follow: BoxAPI["followEvents"];
	/** The most recent events. */
	list: BoxAPI["events"];
	/** @deprecated Use `ryu.box.events.list(boxId, limit?)`. */
	(...args: Parameters<BoxAPI["events"]>): ReturnType<BoxAPI["events"]>;
}

/**
 * The flat BoxAPI names that are not top-level methods, kept as deprecated
 * aliases of the canonical resource methods. Each one makes the same request
 * as its canonical form. (`processes`, `prompts` and `events` are the
 * callable namespaces themselves.)
 */
export interface BoxFlatAliases {
	/** @deprecated Use `ryu.box.prompts.cancel`. */
	cancelPrompt: BoxAPI["cancelPrompt"];
	/** @deprecated Use `ryu.box.previews.create`. */
	createPreview: BoxAPI["createPreview"];
	/** @deprecated Use `ryu.box.previews.delete`. */
	deletePreview: BoxAPI["deletePreview"];
	/** @deprecated Use `ryu.box.secrets.delete`. */
	deleteSecret: BoxAPI["deleteSecret"];
	/** @deprecated Use `ryu.box.snapshots.delete`. */
	deleteSnapshot: BoxAPI["deleteSnapshot"];
	/** @deprecated Use `ryu.box.files.downloadArchive`. */
	downloadArchive: BoxAPI["downloadArchive"];
	/** @deprecated Use `ryu.box.events.follow`. */
	followEvents: BoxAPI["followEvents"];
	/** @deprecated Use `ryu.box.processes.followLogs`. */
	followLogs: BoxAPI["followLogs"];
	/** @deprecated Use `ryu.box.snapshots.get`. */
	getSnapshot: BoxAPI["getSnapshot"];
	/** @deprecated Use `ryu.box.processes.interrupt`. */
	interrupt: BoxAPI["interrupt"];
	/** @deprecated Use `ryu.box.processes.kill`. */
	kill: BoxAPI["kill"];
	/** @deprecated Use `ryu.box.files.list`. */
	listFiles: BoxAPI["listFiles"];
	/** @deprecated Use `ryu.box.previews.list`. */
	listPreviews: BoxAPI["listPreviews"];
	/** @deprecated Use `ryu.box.secrets.list`. */
	listSecrets: BoxAPI["listSecrets"];
	/** @deprecated Use `ryu.box.snapshots.list`. */
	listSnapshots: BoxAPI["listSnapshots"];
	/** @deprecated Use `ryu.box.processes.logs`. */
	logs: BoxAPI["logs"];
	/** @deprecated Use `ryu.box.files.mkdir`. */
	makeDirectory: BoxAPI["makeDirectory"];
	/** @deprecated Use `ryu.box.processes.get`. */
	process: BoxAPI["process"];
	/** @deprecated Use `ryu.box.prompts.create`. */
	prompt: BoxAPI["prompt"];
	/** @deprecated Use `ryu.box.prompts.get`. */
	promptRun: BoxAPI["promptRun"];
	/** @deprecated Use `ryu.box.secrets.set`. */
	putSecret: BoxAPI["putSecret"];
	/** @deprecated Use `ryu.box.files.read`. */
	readFile: BoxAPI["readFile"];
	/** @deprecated Use `ryu.box.files.readText`. */
	readTextFile: BoxAPI["readTextFile"];
	/** @deprecated Use `ryu.box.files.delete`. */
	removePath: BoxAPI["removePath"];
	/** @deprecated Use `ryu.box.snapshots.create`. */
	snapshot: BoxAPI["snapshot"];
	/** @deprecated Use `ryu.box.processes.spawn`. */
	spawn: BoxAPI["spawn"];
	/** @deprecated Use `ryu.box.files.uploadArchive`. */
	uploadArchive: BoxAPI["uploadArchive"];
	/** @deprecated Use `ryu.box.files.write`. */
	writeFile: BoxAPI["writeFile"];
	/** @deprecated Use `ryu.box.processes.writeStdin`. */
	writeStdin: BoxAPI["writeStdin"];
}

/**
 * Every member of `ryu.box` except the three callable namespaces. The
 * top-level Box methods are picked from `BoxAPI`, so hovers show the client's
 * own JSDoc for `list`, `get`, `create`, `exec` and the rest.
 */
export interface BoxNamespaceBase
	extends BoxFlatAliases,
		Pick<BoxAPI, (typeof BOX_TOP_LEVEL_METHODS)[number]> {
	readonly files: BoxFilesNamespace;
	readonly previews: BoxPreviewsNamespace;
	/**
	 * Creates a Box, waits until it is ready, then runs `command` and waits for
	 * it to finish. Resolves to the ready Box and the command's result. A Box
	 * that fails or stays provisioning raises `box_failed` /
	 * `box_ready_timeout` with `details.boxId`; the Box is never deleted for
	 * you. The command runs on the streamed route, so it is not bound by the
	 * call's `timeoutMs`.
	 */
	run(input: BoxRunInput, options?: BoxRunOptions): Promise<BoxRun>;
	readonly secrets: BoxSecretsNamespace;
	readonly snapshots: BoxSnapshotsNamespace;
}

/** A callable namespace in object mode: its call and its members both resolve to RyuResult. */
type SafeCallableNamespace<N, F> = Safe<N> &
	(F extends (...args: infer A) => PromiseLike<infer U>
		? (...args: A) => Promise<RyuResult<U>>
		: F);

/**
 * The object-mode (`result: "object"`, `ryu.safe`) view of `ryu.box`. The
 * mapped projection sees a callable namespace only as a function and would
 * drop its members, so the three callable namespaces are projected here.
 */
export type BoxSafeNamespace = Safe<BoxNamespaceBase> & {
	readonly events: SafeCallableNamespace<BoxEventsNamespace, BoxAPI["events"]>;
	readonly processes: SafeCallableNamespace<
		BoxProcessesNamespace,
		BoxAPI["processes"]
	>;
	readonly prompts: SafeCallableNamespace<
		BoxPromptsNamespace,
		BoxAPI["prompts"]
	>;
};

/** The methods of `ryu.box`: resource namespaces over `BoxAPI`, plus `run()`. */
export interface BoxNamespace extends BoxNamespaceBase {
	readonly events: BoxEventsNamespace;
	readonly processes: BoxProcessesNamespace;
	readonly prompts: BoxPromptsNamespace;
	readonly [SAFE_VIEW]?: BoxSafeNamespace;
}

function boxClient(config: ResolvedServiceConfig, fetch: RyuFetch): BoxAPI {
	return createBoxClient({
		apiKey: config.apiKey ?? "",
		baseUrl: config.baseUrl,
		fetch,
		webSocket: config.webSocket,
	});
}

type BoxMethod = (...args: unknown[]) => unknown;

/**
 * The resource namespaces, built from {@link BOX_CANONICAL_METHODS}. Each
 * member calls the client's method with `this` bound to the client. A
 * namespace whose name is also a BoxAPI method (`processes`, `prompts`,
 * `events`) is a function that makes that call, so the flat name keeps
 * working.
 */
function resourceNamespaces(client: BoxAPI): Record<string, object> {
	const bound = (method: string): BoxMethod => {
		const fn = Reflect.get(client, method) as BoxMethod;
		return (...args) => fn.apply(client, args);
	};
	const groups: Record<string, Record<string, unknown>> = {};
	for (const [path, method] of Object.entries(BOX_CANONICAL_METHODS)) {
		const [group = path, verb = path] = path.split(".");
		if (groups[group] === undefined) {
			groups[group] =
				typeof Reflect.get(client, group) === "function"
					? (bound(group) as unknown as Record<string, unknown>)
					: {};
		}
		groups[group][verb] = bound(method);
	}
	return groups;
}

/** Builds the Box namespace for one call. Does no I/O. */
export function createBoxNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {},
	deps: BoxRunDeps = {}
): BoxNamespace {
	const client = boxClient(config, fetch);
	const additions = {
		...resourceNamespaces(client),
		run: (input: BoxRunInput, runOptions: BoxRunOptions = {}) =>
			runBox(
				input,
				runOptions,
				(signal) => boxClient(config, withSignal(fetch, signal)),
				options,
				deps
			),
	};
	// The top-level methods and the deprecated flat aliases are the client's
	// own methods, inherited, so they run with `this` bound to a BoxAPI-shaped
	// object and keep reading its options. The callable namespaces shadow
	// `processes`, `prompts` and `events` and make the same call.
	return Object.assign(
		Object.create(client) as BoxAPI,
		additions
	) as unknown as BoxNamespace;
}

/** How the facade wraps Box. */
export const BOX_NAMESPACE: NamespaceDefinition<BoxNamespace> = {
	create: (config, fetch, options) =>
		createBoxNamespace(config, fetch, options),
	errors: "throw",
	routes: BOX_ROUTES,
	service: "box",
};
