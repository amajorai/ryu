// packages/services/src/tools/box.ts
//
// Ryu Box tools (`box_*`): list, get, create, exec, read_file, write_file,
// stop, resume and delete.
//
// `box_create` takes an optional model-supplied `idempotencyKey` (see
// idempotency.ts): reusing it when a tool call is retried returns the first
// Box instead of creating a second one. Without it the SDK mints a key per
// tool call, which covers only its own HTTP retries, not a host retrying the
// tool call. Box stores a hash of the create body with the key, so the default
// name is derived from the key (`defaultToolBoxName`): a retried call sends the
// same body and is replayed rather than answered with `idempotency_conflict`. `box_exec` runs the command once and waits for it (the
// command route is never retried), so a tool call never runs a command twice;
// it is marked destructive and open-world because a command can change files
// and, on a Box with egress, reach the network. `box_create` is open-world
// for the same reason: its `setup` commands run as root. The service answers
// only once the command has ended, so the request timeout is raised to cover
// the command's own timeout. `box_read_file` returns at most `maxChars`
// characters (default 20,000, like `passport_fetch`) and says whether it cut
// the file, so one read cannot fill a model's context. `box_get` reads one
// Box, so an agent can poll a provisioning Box. `box_stop` is destructive
// too: it ends every running process. `box_resume` starts a stopped Box
// again; it is a write but not destructive, and resuming a Box that is
// ready or running answers the Box as it is (apps/box service.ts), so it
// is idempotent. `box_delete` destroys the Box and its disk.

import * as z from "zod";
import { READ } from "./annotations.ts";
import { HEADER_KEY_128, optionalIdempotencyKey } from "./idempotency.ts";
import { NO_DATA, nullableText, toolOutput } from "./output.ts";
import { settled, settledMap } from "./run.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

/**
 * Lower-case hex SHA-256 of `text`. A local copy of box/helpers.ts's: tool
 * modules reach the package only through tools/core.ts, whose names must be
 * root exports.
 */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

/**
 * The name `box_create` gives a Box when the model passes none. With a key it
 * is `mcp-` plus the first 12 hex digits of the key's SHA-256, so a retried
 * tool call sends a byte-identical create body (Box hashes the body under the
 * key); without one it is random. The Python port
 * (ryu_sdk/services/tools/_bodies.py `box_create`) derives the same name.
 */
export async function defaultToolBoxName(
	idempotencyKey: string | undefined
): Promise<string> {
	if (idempotencyKey === undefined) {
		return `mcp-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	}
	return `mcp-${(await sha256Hex(idempotencyKey)).slice(0, 12)}`;
}

/** The service's default command timeout, in seconds (apps/box contracts). */
export const DEFAULT_COMMAND_TIMEOUT_SECS = 120;
/** Extra request time beyond the command's own timeout, for queueing and the reply. */
export const EXEC_TIMEOUT_MARGIN_MS = 30_000;
/** How many characters `box_read_file` returns by default. */
export const DEFAULT_BOX_READ_CHARS = 20_000;
/** The most characters one `box_read_file` call returns. */
export const MAX_BOX_READ_CHARS = 200_000;

const boxId = z.string().min(1).describe("Box id (bx_…).");

const createInput = z.object({
	name: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Box name (default mcp-<12 hex>, derived from idempotencyKey when one is given)."
		),
	size: z
		.enum(["small", "default", "large"])
		.optional()
		.describe("Machine size (default: the service's default)."),
	image: z.string().min(1).optional().describe("Container image to boot."),
	setup: z
		.array(z.string().min(1))
		.max(16)
		.optional()
		.describe(
			"Shell commands run as root, in order, before the Box is ready. With setup the Box comes back provisioning."
		),
	idempotencyKey: optionalIdempotencyKey({
		subject: "Box",
		format: "printable ASCII without spaces, 1-128 characters",
		pattern: HEADER_KEY_128,
		duplicate: "creating a second Box",
		fresh: "creates a new Box",
	}),
});

const execInput = z.object({
	boxId,
	command: z
		.string()
		.min(1)
		.describe(
			"The executable, optionally followed by arguments (split like a shell would, without running one). Use sh -c for pipes."
		),
	args: z.array(z.string()).max(64).optional().describe("More arguments."),
	cwd: z.string().optional().describe("Working directory under /workspace."),
	user: z
		.enum(["box", "root"])
		.optional()
		.describe('Run as "box" (default) or "root".'),
	timeoutSecs: z
		.int()
		.min(1)
		.max(3600)
		.optional()
		.describe("Kill the command after this long (default 120)."),
});

const fileInput = z.object({
	boxId,
	path: z
		.string()
		.min(1)
		.describe("Path in the Box; relative paths resolve against /workspace."),
});

const readFileInput = fileInput.extend({
	maxChars: z
		.int()
		.min(1)
		.max(MAX_BOX_READ_CHARS)
		.optional()
		.describe(
			`Return at most this many characters (default ${DEFAULT_BOX_READ_CHARS}); the result says truncated: true when the file is longer.`
		),
});

const writeFileInput = fileInput.extend({
	content: z.string().describe("The file's new text content (UTF-8)."),
});

const boxIdInput = z.object({ boxId });

// Replies, mirroring the Box contracts (packages/client box-contracts.ts
// `boxValidation` and `resultValidation`). `box_write_file`, `box_stop` and
// `box_delete` answer with no body, so their data is null.

const boxData = z
	.looseObject({
		id: z.string(),
		name: z.string(),
		size: z.enum(["small", "default", "large"]),
		status: z.enum([
			"provisioning",
			"ready",
			"running",
			"stopped",
			"error",
			"deleted",
		]),
		lastError: nullableText,
		image: z.string(),
		driver: z.string(),
		network: z.enum(["none", "egress", "allowlist"]),
		allowedHosts: z.array(z.string()),
		envNames: z.array(z.string()),
		secrets: z.array(z.string()),
		repo: z.looseObject({ branch: nullableText, url: z.string() }).nullable(),
		snapshotId: nullableText,
		stoppedAt: nullableText,
		ttlSeconds: z.number().nullable(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Box.");

const execData = z.looseObject({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	durationMs: z.number(),
});

const readFileData = z.object({
	path: z.string(),
	content: z.string(),
	truncated: z.boolean(),
	totalChars: z.number(),
});

/** Stops or destroys something; repeating it changes nothing more. */
const DESTRUCTIVE_IDEMPOTENT = Object.freeze({
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
});

/** Changes state without destroying anything; repeating it changes nothing more. */
const WRITE_IDEMPOTENT = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

/** The Ryu Box tools. */
export const BOX_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "box",
		name: "box_list",
		title: "List Boxes",
		description:
			"Lists the tenant's Ryu Boxes with their id, name, size, status and network policy.",
		inputSchema: z.object({}),
		annotations: READ,
		outputSchema: toolOutput(z.array(boxData)),
		run: (ryu) => ryu.box.list(),
	}),
	defineRyuTool({
		service: "box",
		name: "box_get",
		title: "Get a Box",
		description:
			"Returns one Box with its id, name, size, status (provisioning, ready, running, stopped or error), lastError and network policy. Poll it after box_create until the status leaves provisioning.",
		inputSchema: boxIdInput,
		annotations: READ,
		outputSchema: toolOutput(boxData),
		run: (ryu, { boxId: id }) => ryu.box.get(id),
	}),
	defineRyuTool({
		service: "box",
		name: "box_create",
		title: "Create a Box",
		description:
			"Creates a persistent Linux workspace. It is ready at once, or provisioning while setup runs; check its status with box_get before box_exec. Setup commands run as root and, on a Box with egress, can reach the network. Pass an idempotencyKey so a retried call never creates a second Box.",
		inputSchema: createInput,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		outputSchema: toolOutput(boxData),
		run: async (ryu, { name, idempotencyKey, ...input }) => {
			const boxName = name ?? (await defaultToolBoxName(idempotencyKey));
			return settled(
				(idempotencyKey === undefined
					? ryu.box
					: ryu.box.with({ idempotencyKey })
				).create({ ...input, name: boxName })
			);
		},
	}),
	defineRyuTool({
		service: "box",
		name: "box_exec",
		title: "Run a command in a Box",
		description:
			"Runs one command in a Box, waits for it, and returns { exitCode, stdout, stderr, durationMs }. The command runs once; a failed call is never replayed.",
		inputSchema: execInput,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		outputSchema: toolOutput(execData),
		run: (ryu, { boxId: id, ...input }) =>
			ryu.box
				.with({
					timeoutMs:
						(input.timeoutSecs ?? DEFAULT_COMMAND_TIMEOUT_SECS) * 1000 +
						EXEC_TIMEOUT_MARGIN_MS,
				})
				.exec(id, input),
	}),
	defineRyuTool({
		service: "box",
		name: "box_read_file",
		title: "Read a file from a Box",
		description:
			"Returns { path, content, truncated, totalChars }: the file as UTF-8 text, cut to maxChars (default 20 000). Binary files come back with replacement characters.",
		inputSchema: readFileInput,
		annotations: READ,
		outputSchema: toolOutput(readFileData),
		run: (ryu, { boxId: id, path, maxChars }) =>
			settledMap(ryu.box.files.readText(id, path), (text) => {
				const limit = maxChars ?? DEFAULT_BOX_READ_CHARS;
				return {
					path,
					content: text.length > limit ? text.slice(0, limit) : text,
					truncated: text.length > limit,
					totalChars: text.length,
				};
			}),
	}),
	defineRyuTool({
		service: "box",
		name: "box_write_file",
		title: "Write a file in a Box",
		description:
			"Creates or replaces a file with the given UTF-8 text. Missing parent directories are created. A relative path resolves against /workspace. Ryu Box accepts at most 64 MiB per file; a larger body answers 413 body_too_large.",
		inputSchema: writeFileInput,
		annotations: DESTRUCTIVE_IDEMPOTENT,
		outputSchema: NO_DATA,
		run: (ryu, { boxId: id, path, content }) =>
			ryu.box.files.write(id, path, content),
	}),
	defineRyuTool({
		service: "box",
		name: "box_stop",
		title: "Stop a Box",
		description:
			"Stops a Box: running processes end and compute metering pauses. The disk is kept; start it again with box_resume before box_exec.",
		inputSchema: boxIdInput,
		annotations: DESTRUCTIVE_IDEMPOTENT,
		outputSchema: NO_DATA,
		run: (ryu, { boxId: id }) => ryu.box.stop(id),
	}),
	defineRyuTool({
		service: "box",
		name: "box_resume",
		title: "Resume a Box",
		description:
			"Starts a stopped Box again with its disk as it was and returns the Box; compute metering restarts. Processes that ended on stop do not come back. Resuming a Box that is already ready or running returns it unchanged.",
		inputSchema: boxIdInput,
		annotations: WRITE_IDEMPOTENT,
		outputSchema: toolOutput(boxData),
		run: (ryu, { boxId: id }) => ryu.box.resume(id),
	}),
	defineRyuTool({
		service: "box",
		name: "box_delete",
		title: "Delete a Box",
		description:
			"Deletes a Box and its disk. Not reversible: files that were not downloaded or snapshotted are lost.",
		inputSchema: boxIdInput,
		annotations: DESTRUCTIVE_IDEMPOTENT,
		outputSchema: NO_DATA,
		run: (ryu, { boxId: id }) => ryu.box.delete(id),
	}),
];
