// The config file for `ryu secrets agent --config FILE`.
//
// JSON, like the other files the CLI reads (`.ryu-vault.json`, dynamic role
// files). It names coordinates and file paths, never a credential: the AppRole
// secret id, a JWT or a token are read from the files it names, on every
// login, so a rotated credential file is picked up without a restart.
// Relative paths resolve against the config file's directory.
//
// {
//   "version": 1,
//   "environment": "prod", "path": "/",            defaults for {{secret:NAME}}
//   "auth": { "method": "approle", "roleId": "…", "secretIdFile": "secret-id" }
//         | { "method": "jwt", "identity": "ci", "jwtFile": "jwt" }
//         | { "method": "token", "tokenFile": "token" } | { "method": "env" },
//   "sinks": [{ "path": "vault-token", "mode": "0600" }],
//   "leases": [{ "name": "db", "role": "postgres-ro", "ttl": "1h" }],
//   "templates": [{ "source": "app.env.tpl", "destination": "app.env",
//                   "mode": "0600", "command": ["systemctl", "reload", "app"] }],
//   "renderInterval": "10m", "revokeLeasesOnExit": true
// }

import { dirname, resolve } from "node:path";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { parseDuration } from "./secrets-args.ts";
import { UsageError } from "./types.ts";

const text = z.string().trim().min(1);
const fileMode = z
	.string()
	.regex(/^0?[0-7]{3}$/u)
	.transform((mode) => Number.parseInt(mode, 8));
const duration = z.string().trim().min(1);

const authSchema = z.discriminatedUnion("method", [
	z.strictObject({
		method: z.literal("approle"),
		roleId: text.optional(),
		roleIdFile: text.optional(),
		secretIdFile: text,
	}),
	z.strictObject({
		method: z.literal("jwt"),
		identity: text,
		jwtFile: text,
	}),
	z.strictObject({ method: z.literal("token"), tokenFile: text }),
	z.strictObject({ method: z.literal("env") }),
]);

const configSchema = z.strictObject({
	version: z.literal(1),
	environment: text.optional(),
	path: z.string().startsWith("/").optional(),
	auth: authSchema,
	sinks: z
		.array(z.strictObject({ path: text, mode: fileMode.optional() }))
		.optional(),
	leases: z
		.array(
			z.strictObject({
				name: z.string().regex(/^[A-Za-z0-9_-]+$/u),
				role: text,
				ttl: duration.optional(),
			})
		)
		.optional(),
	templates: z
		.array(
			z.strictObject({
				source: text,
				destination: text,
				mode: fileMode.optional(),
				command: z.array(z.string().min(1)).min(1).optional(),
				commandTimeout: duration.optional(),
			})
		)
		.optional(),
	renderInterval: duration.optional(),
	revokeLeasesOnExit: z.boolean().optional(),
});

export type AgentAuth =
	| {
			kind: "approle";
			roleId: string | null;
			roleIdFile: string | null;
			secretIdFile: string;
	  }
	| { kind: "jwt"; identity: string; jwtFile: string }
	| { kind: "token"; tokenFile: string }
	| { kind: "env" };

export interface AgentLeaseConfig {
	name: string;
	role: string;
	ttlSecs: number | undefined;
}

export interface AgentTemplateConfig {
	command: string[] | null;
	commandTimeoutMs: number;
	destination: string;
	mode: number;
	source: string;
}

export interface AgentConfig {
	auth: AgentAuth;
	defaults: { environment?: string; path?: string };
	leases: AgentLeaseConfig[];
	renderIntervalMs: number | null;
	revokeLeasesOnExit: boolean;
	sinks: { mode: number; path: string }[];
	templates: AgentTemplateConfig[];
}

/** Rendered files and sinks hold credentials: owner-only unless set. */
export const PRIVATE_MODE = 0o600;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function fail(file: string, field: string): UsageError {
	return new UsageError(
		tf("{file} is not a valid agent config: {field} is invalid.", {
			file,
			field,
		})
	);
}

function durationMs(value: string, file: string, field: string): number {
	try {
		return parseDuration(value) * 1000;
	} catch {
		throw fail(file, field);
	}
}

function auth(
	parsed: z.infer<typeof authSchema>,
	at: (path: string) => string,
	file: string
): AgentAuth {
	if (parsed.method === "approle") {
		if (Boolean(parsed.roleId) === Boolean(parsed.roleIdFile)) {
			throw fail(file, "auth.roleId");
		}
		return {
			kind: "approle",
			roleId: parsed.roleId ?? null,
			roleIdFile: parsed.roleIdFile ? at(parsed.roleIdFile) : null,
			secretIdFile: at(parsed.secretIdFile),
		};
	}
	if (parsed.method === "jwt") {
		return {
			kind: "jwt",
			identity: parsed.identity,
			jwtFile: at(parsed.jwtFile),
		};
	}
	if (parsed.method === "token") {
		return { kind: "token", tokenFile: at(parsed.tokenFile) };
	}
	return { kind: "env" };
}

/** Parse the config text. Errors name the file and the field, never a value. */
export function parseAgentConfig(textValue: string, file: string): AgentConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(textValue);
	} catch {
		throw new UsageError(tf("{file} is not valid JSON.", { file }));
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw fail(file, parsed.error.issues[0]?.path.join(".") || "(root)");
	}
	const data = parsed.data;
	const base = dirname(resolve(file));
	// `resolve` keeps an absolute path (normalized) and anchors a relative one.
	const at = (path: string) => resolve(base, path);
	const templates = (data.templates ?? []).map((template, index) => ({
		source: at(template.source),
		destination: at(template.destination),
		mode: template.mode ?? PRIVATE_MODE,
		command: template.command ?? null,
		commandTimeoutMs:
			template.commandTimeout === undefined
				? DEFAULT_COMMAND_TIMEOUT_MS
				: durationMs(
						template.commandTimeout,
						file,
						`templates.${index}.commandTimeout`
					),
	}));
	const destinations = new Set(templates.map((t) => t.destination));
	if (destinations.size !== templates.length) {
		throw fail(file, "templates.destination");
	}
	const leases = (data.leases ?? []).map((lease, index) => ({
		name: lease.name,
		role: lease.role,
		ttlSecs:
			lease.ttl === undefined
				? undefined
				: durationMs(lease.ttl, file, `leases.${index}.ttl`) / 1000,
	}));
	if (new Set(leases.map((lease) => lease.name)).size !== leases.length) {
		throw fail(file, "leases.name");
	}
	const defaults: AgentConfig["defaults"] = {};
	if (data.environment) {
		defaults.environment = data.environment;
	}
	if (data.path) {
		defaults.path = data.path;
	}
	return {
		auth: auth(data.auth, at, file),
		defaults,
		leases,
		templates,
		sinks: (data.sinks ?? []).map((sink) => ({
			path: at(sink.path),
			mode: sink.mode ?? PRIVATE_MODE,
		})),
		renderIntervalMs:
			data.renderInterval === undefined
				? null
				: durationMs(data.renderInterval, file, "renderInterval"),
		revokeLeasesOnExit: data.revokeLeasesOnExit ?? true,
	};
}
