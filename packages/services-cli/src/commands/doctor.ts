// packages/services-cli/src/commands/doctor.ts
//
// `ryu-services doctor [--check]`: what each service resolves to from env,
// with every key shown only as set or unset. `--check` also probes each
// configured service once with the cheapest authenticated read it has
// (Managed Agents' `agents?limit=1`; Mail's `/api/mail/pods` when hosted or
// `/api/mail/status` when self-hosted; Notify's `/v1/events?limit=1`; Box's
// `/v1/boxes`; Sites' `/api/sites/status`; Passport's `/v1/capabilities`, or
// `/v1/runtime/connections` with only a runtime grant) and exits 1 when any
// probe fails, or when a service that env sets does not resolve (a bad or
// missing URL), since it is never probed. Gateway and Connect are probed on their public `/health`. A
// service that resolves only through a built-in default (Gateway's local URL)
// counts as not set, as it does for the MCP server, and is not probed. Box and
// Notify default to their hosted origins but still need a key, so they are
// set only once that key is. Hosted Mail reached with the control-plane
// `RYU_API_KEY` (no Mail gateway or self-hosted key) counts as set, because
// `new Ryu({ env })` serves it, lists `RYU_API_KEY` and `RYU_ORGANIZATION_ID`
// among its variables, and is probed with `x-api-key`. The pods probe needs
// `mail:read`, so a `ryu_` key answered with 403 `insufficient_scope` (a
// send-only key) is reported as authenticated but scope-limited, not as a
// failure. Each probe says whether it verified the key. A service that is
// not configured but has credential-free MCP tools (`mail_status` on hosted
// Mail, `messaging_status`) names them (`credentialFreeTools`), because
// `ryu-services mcp` still registers them. While
// `@ryuhq/services` is unpublished, the report ends with the npm-status note
// (`DoctorOptions.npmNote`, which `runCli` derives from `npmStatusNote`;
// `npmNote` under `--json`).

import type {
	ResolvedServiceConfig,
	RyuError,
	RyuFetch,
	RyuService,
} from "@ryuhq/services";
import {
	AVAILABILITY,
	createEnvReader,
	ENV_VARS,
	isRyuError,
	messageWithoutHint,
	NPM_PUBLISHED_VERSION,
	parseErrorResponse,
	Ryu,
	resolveServiceConfig,
} from "@ryuhq/services";
import { credentialFreeRyuTools } from "@ryuhq/services/tools";
import type { FlagSpecs } from "../args.ts";
import { cliHintText } from "../hints.ts";
import { explicitlyConfigured } from "../mcp/registry.ts";
import { missingPhrase } from "../missing.ts";
import { EXIT_CODES, type ExitCode, toJson, writeLine } from "../output.ts";
import { DEFAULT_PROGRAM, withProgram } from "../program.ts";
import { type CommandIo, cliNameOf } from "../registry.ts";
import { NPM_STATUS_NOTE } from "../version.ts";

/** `doctor` flags. */
export const DOCTOR_FLAGS: FlagSpecs = {
	check: {
		type: "boolean",
		description:
			"Probe each configured service once with an authenticated read (Managed Agents agents?limit=1; Mail /api/mail/pods hosted, which needs mail:read on a ryu_ key, or /api/mail/status self-hosted; Notify /v1/events?limit=1; Box /v1/boxes; Sites /api/sites/status; Messaging /api/messaging/orgs/{orgId}/settings, which needs messaging:read; Passport /v1/capabilities or /v1/runtime/connections). Gateway and Connect get GET /health, which checks reachability only.",
	},
};

/** One env var as doctor reports it. Key values are never included. */
export interface DoctorEnvVar {
	readonly name: string;
	readonly role: string;
	readonly set: boolean;
	/** URL vars only: the value without credentials, query or fragment. */
	readonly value?: string;
}

/** The result of one `--check` probe. */
export interface DoctorProbe {
	/**
	 * True when the probed route checks credentials, so `ok` means the key
	 * was accepted. False for public liveness routes (`/health`): `ok` then
	 * means reachable only.
	 */
	readonly authVerified: boolean;
	readonly code: string | null;
	readonly ok: boolean;
	/**
	 * True when a `ryu_` key was accepted but lacks the scope the probe reads
	 * (403 `insufficient_scope`): `ok` is true, the key works for what its
	 * scopes allow.
	 */
	readonly scopeLimited?: boolean;
	readonly status: number;
	/** The probed URL, without its query string. */
	readonly url: string;
}

/** One service as doctor reports it. */
export interface DoctorService {
	readonly auth: string | null;
	readonly availability: string;
	readonly baseUrl: string | null;
	readonly cli: string | null;
	/** True when the config resolves and is set explicitly (env or flags), not from a default alone. */
	readonly configured: boolean;
	/**
	 * The tools `ryu-services mcp` still registers for this service while it
	 * is not configured, because they need no credentials and send none
	 * (`mail_status` on hosted Mail, `messaging_status`): the registry's
	 * `credentialFreeRyuTools`, the rule the MCP server applies. Empty when
	 * the service is configured or has no such tool.
	 */
	readonly credentialFreeTools: readonly string[];
	/** True when the service resolves only through a built-in default (Gateway's local URL). */
	readonly defaulted: boolean;
	readonly env: readonly DoctorEnvVar[];
	readonly mailMode: string | null;
	readonly probe?: DoctorProbe;
	/**
	 * Why the service is not configured: the SDK's configuration error, with
	 * its message and hint apart (the message never repeats the hint).
	 */
	readonly problem: {
		code: string;
		hint: string | null;
		message: string;
		missing: string[];
	} | null;
	readonly service: RyuService;
}

/** The services doctor reports on, in docs order. */
export const DOCTOR_SERVICES: readonly RyuService[] = Object.keys(
	AVAILABILITY
) as RyuService[];

function envNames(service: RyuService): string[] {
	return ENV_VARS.filter((row) => row.service === service).map(
		(row) => row.name
	);
}

/** A URL without userinfo, query or fragment. */
export function safeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return "(invalid URL)";
	}
}

/**
 * The env rows doctor lists for `service`. Mail also lists the control-plane
 * key and organization, which reach hosted Mail when no Mail key is set.
 */
function envRowsOf(service: RyuService): typeof ENV_VARS {
	const own = ENV_VARS.filter((row) => row.service === service);
	if (service !== "mail") {
		return own;
	}
	return [
		...own,
		...ENV_VARS.filter(
			(row) =>
				row.service === "managedAgents" &&
				(row.role === "key" || row.role === "organization")
		),
	];
}

function envRows(service: RyuService, env: CommandIo["env"]): DoctorEnvVar[] {
	const read = createEnvReader({ ...env });
	return envRowsOf(service).map((row) => {
		const value = read(row.name);
		const entry: DoctorEnvVar = {
			name: row.name,
			role: row.role,
			set: value !== undefined,
		};
		return row.role === "url" && value !== undefined
			? { ...entry, value: safeUrl(value) }
			: entry;
	});
}

function missingOf(details: unknown): string[] {
	if (typeof details === "object" && details !== null) {
		const { missing, invalid } = details as {
			invalid?: unknown;
			missing?: unknown;
		};
		const list = Array.isArray(missing) ? missing : invalid;
		if (Array.isArray(list)) {
			return list.filter((item): item is string => typeof item === "string");
		}
	}
	return [];
}

/**
 * `hint` in CLI words for doctor, which takes no `--api-key` or `--base-url`
 * itself: the flags are named on the service's own commands.
 */
function doctorHintText(
	service: RyuService | null,
	hint: string,
	program: string | undefined
): string {
	const name = service === null ? undefined : cliNameOf(service);
	const command = program?.trim() || DEFAULT_PROGRAM;
	return withProgram(
		cliHintText(service, hint, {
			command:
				name === undefined
					? `a ${command} command`
					: `a \`${command} ${name}\` command`,
		}),
		program
	);
}

/** A doctor `problem` from an SDK configuration error: the message without
 *  its `Hint:` suffix, and the hint on its own, both in CLI words
 *  (`--api-key` on a service command, not the SDK's `new Ryu()` options). */
export function configurationProblemOf(
	error: Pick<RyuError, "code" | "details" | "hint" | "message"> &
		Partial<Pick<RyuError, "service">>,
	program?: string
): NonNullable<DoctorService["problem"]> {
	const service = error.service ?? null;
	return {
		code: error.code,
		hint: error.hint ? doctorHintText(service, error.hint, program) : null,
		message: doctorHintText(service, messageWithoutHint(error), program),
		missing: missingOf(error.details),
	};
}

/** The control-plane variables several services read; they never name one service. */
const SHARED_CONTROL_PLANE_VARS: ReadonlySet<string> = new Set([
	"RYU_API_KEY",
	"RYU_ORGANIZATION_ID",
]);

/**
 * True when env sets a variable that belongs to this service alone. The shared
 * control-plane key alone does not name Messaging or Mail: Managed Agents
 * resolves on it, so a service that cannot resolve from it is not a failure.
 */
function namedByOwnEnv(service: RyuService, env: CommandIo["env"]): boolean {
	const read = createEnvReader({ ...env });
	return ENV_VARS.some(
		(row) =>
			row.service === service &&
			!SHARED_CONTROL_PLANE_VARS.has(row.name) &&
			read(row.name) !== undefined
	);
}

/** Resolves one service exactly as `new Ryu({ env })` would on its first call. */
export function inspectService(
	service: RyuService,
	env: CommandIo["env"],
	program?: string
): {
	report: DoctorService;
	config: ResolvedServiceConfig | null;
	/** True when env names the service but it does not resolve (bad or missing URL). */
	unresolved: boolean;
} {
	const base = {
		service,
		cli: cliNameOf(service) ?? null,
		availability: AVAILABILITY[service],
		env: envRows(service, env),
		credentialFreeTools: credentialFreeRyuTools(
			new Ryu({ env: { ...env } }),
			service
		).map((tool) => tool.name),
	};
	try {
		const options = { env: { ...env } };
		const config = resolveServiceConfig(
			service,
			options,
			createEnvReader(options.env)
		);
		// Hosted Mail on RYU_API_KEY is set by that key, which is a
		// Managed Agents row, so the per-service check alone misses it.
		const explicit =
			explicitlyConfigured(service, options) ||
			(service === "mail" && config.auth === "x-api-key");
		const missing = envNames(service);
		return {
			config: explicit ? config : null,
			unresolved: false,
			report: {
				...base,
				configured: explicit,
				defaulted: !explicit,
				baseUrl: safeUrl(config.baseUrl),
				auth: config.auth,
				mailMode: config.mailMode,
				problem: explicit
					? null
					: {
							code: "not_set",
							hint: null,
							message: `Only the default applies; set ${missing.join(" or ")}.`,
							missing,
						},
			},
		};
	} catch (error) {
		if (!isRyuError(error)) {
			throw error;
		}
		return {
			config: null,
			unresolved: namedByOwnEnv(service, env),
			report: {
				...base,
				configured: false,
				defaulted: false,
				baseUrl: null,
				auth: null,
				mailMode: null,
				problem: configurationProblemOf(error, program),
			},
		};
	}
}

/**
 * The URL `--check` probes for a resolved service. Userinfo is dropped: the
 * service's own auth header carries the key, and fetch rejects URLs with
 * embedded credentials.
 */
export function probeUrl(config: ResolvedServiceConfig): string {
	const url = new URL(config.baseUrl);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	const base = url.href.replace(/\/+$/u, "");
	switch (config.service) {
		case "managedAgents":
			return `${base}/api/v1/managed-agents/agents?limit=1`;
		case "messaging":
			// The settings read needs messaging:read and passes the rollout
			// and feature gates, so it checks the key and the organization.
			return `${base}/api/messaging/orgs/${encodeURIComponent(config.organizationId ?? "")}/settings`;
		case "mail":
			// Hosted Mail's status route is public, so hosted probes list pods:
			// the cheapest read that checks the gateway key (and the products.mail
			// feature). Self-hosted Mail guards status with its bearer.
			return config.mailMode === "hosted"
				? `${base}/api/mail/pods`
				: `${base}/api/mail/status`;
		case "notify":
			return `${base}/v1/events?limit=1`;
		case "box":
			return `${base}/v1/boxes`;
		case "sites":
			return `${base}/api/sites/status`;
		case "passport":
			// The capabilities route needs the administration token; a
			// runtime-only agent probes its grant's connection list instead.
			return config.apiKey === null
				? `${base}/v1/runtime/connections`
				: `${base}/v1/capabilities`;
		default:
			return `${base}/health`;
	}
}

/** Services whose probe route rejects a bad key (see {@link probeUrl}). */
const AUTH_VERIFYING_PROBES: ReadonlySet<RyuService> = new Set<RyuService>([
	"managedAgents",
	"messaging",
	"mail",
	"notify",
	"box",
	"sites",
	"passport",
]);

/**
 * True when the probe route rejects a bad key. Gateway's and Connect's
 * `/health` is public, so it only shows the service is reachable.
 */
export function probeVerifiesAuth(config: ResolvedServiceConfig): boolean {
	return AUTH_VERIFYING_PROBES.has(config.service);
}

function probeHeaders(config: ResolvedServiceConfig): Headers {
	const headers = new Headers({ accept: "application/json" });
	// A runtime-only Passport config probes with its runtime grant.
	const key = config.apiKey ?? config.runtimeKey;
	if (key !== null) {
		if (config.auth === "bearer") {
			headers.set("authorization", `Bearer ${key}`);
		} else {
			headers.set(config.auth, key);
		}
	}
	if (config.organizationId !== null) {
		headers.set("x-ryu-organization", config.organizationId);
	}
	return headers;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Sends one GET to the service with its own auth scheme. Never follows
 * redirects, so a key never changes origin. Network failures and timeouts
 * become a failed probe with status 0.
 */
export async function probeService(
	config: ResolvedServiceConfig,
	fetchImpl: RyuFetch,
	timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<DoctorProbe> {
	const url = probeUrl(config);
	const shownUrl = safeUrl(url);
	const authVerified = probeVerifiesAuth(config);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: probeHeaders(config),
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return {
				authVerified,
				ok: true,
				status: response.status,
				code: null,
				url: shownUrl,
			};
		}
		const error = await parseErrorResponse(
			config.service,
			response,
			"GET",
			url
		);
		if (
			config.auth === "x-api-key" &&
			response.status === 403 &&
			error.code === "insufficient_scope"
		) {
			return {
				authVerified,
				ok: true,
				scopeLimited: true,
				status: response.status,
				code: error.code,
				url: shownUrl,
			};
		}
		return {
			authVerified,
			ok: false,
			status: response.status,
			code: error.code,
			url: shownUrl,
		};
	} catch {
		return {
			authVerified,
			ok: false,
			status: 0,
			code: controller.signal.aborted ? "timeout" : "connection_error",
			url: shownUrl,
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
	readonly check: boolean;
	readonly fetch: RyuFetch;
	readonly io: CommandIo;
	readonly json: boolean;
	/** The trailing note; default `NPM_STATUS_NOTE` (null once published). */
	readonly npmNote?: string | null;
	/** Default `NPM_PUBLISHED_VERSION`. */
	readonly npmPublishedVersion?: string | null;
	readonly timeoutMs?: number;
}

function probeLabel(probe: DoctorProbe): string {
	if (!probe.ok) {
		return "failed";
	}
	if (probe.scopeLimited === true) {
		return "authenticated (key lacks the scope this probe reads)";
	}
	return probe.authVerified ? "authenticated" : "reachable (auth not verified)";
}

/**
 * The doctor line for a service that is not configured but still has
 * credential-free MCP tools, naming the host's command (`program`).
 */
function credentialFreeLine(
	service: RyuService,
	tools: readonly string[],
	program: string | undefined
): string {
	const one = tools.length === 1;
	// `registerServiceTools` drops a service outside `--services` before it
	// looks for credential-free tools, so the line names that exception.
	return withProgram(
		`mcp: \`ryu-services mcp\` still registers ${tools.join(", ")} (unless --services leaves ${service} out), which ${one ? "needs" : "need"} no credentials and ${one ? "sends" : "send"} none`,
		program
	);
}

/**
 * One service's lines in the human doctor report. `program` is the command
 * that runs the CLI (`ryu-cli services` under the host), default
 * `ryu-services`.
 */
export function humanReport(service: DoctorService, program?: string): string {
	const name = (service.cli ?? service.service).padEnd(15);
	const lines: string[] = [];
	if (service.configured) {
		const mode = service.mailMode ? ` (${service.mailMode})` : "";
		lines.push(
			`${name}configured${mode}  ${service.baseUrl ?? ""}  auth: ${service.auth ?? "none"}`
		);
	} else if (service.defaulted) {
		lines.push(
			`${name}default (not set)  ${service.baseUrl ?? ""}  (set ${service.problem?.missing.join(" or ") ?? ""}; not probed)`
		);
	} else {
		const missing = missingPhrase(
			service.service,
			service.problem?.missing ?? []
		);
		lines.push(
			`${name}not configured${missing ? `  (${missing})` : `  (${service.problem?.message ?? ""})`}`
		);
		// The missing-variable phrase already says what to set; otherwise the
		// hint gets its own line, as in error output.
		if (!missing && service.problem?.hint) {
			lines.push(`${"".padEnd(15)}hint: ${service.problem.hint}`);
		}
	}
	if (!service.configured && service.credentialFreeTools.length > 0) {
		lines.push(
			`${"".padEnd(15)}${credentialFreeLine(
				service.service,
				service.credentialFreeTools,
				program
			)}`
		);
	}
	const vars = service.env
		.map((row) => `${row.name}=${row.value ?? (row.set ? "set" : "unset")}`)
		.join("  ");
	lines.push(`${"".padEnd(15)}${vars}`);
	if (service.probe) {
		const { probe } = service;
		lines.push(
			`${"".padEnd(15)}check: ${probeLabel(probe)} ${probe.status}${probe.code ? ` ${probe.code}` : ""}  ${probe.url}`
		);
	}
	return lines.join("\n");
}

/**
 * Runs `doctor`. Exit 0, or 1 when `--check` found a failing service or a
 * service that env sets but that does not resolve (for example a URL without
 * a scheme). Only explicitly configured services are probed or counted.
 */
export async function runDoctor(options: DoctorOptions): Promise<ExitCode> {
	const { io } = options;
	const npmNote =
		options.npmNote === undefined ? NPM_STATUS_NOTE : options.npmNote;
	const npmPublishedVersion =
		options.npmPublishedVersion === undefined
			? NPM_PUBLISHED_VERSION
			: options.npmPublishedVersion;
	const reports: DoctorService[] = [];
	let failed = false;
	for (const service of DOCTOR_SERVICES) {
		const { report, config, unresolved } = inspectService(
			service,
			io.env,
			io.program
		);
		if (options.check && unresolved) {
			// Set on purpose but unusable: every call would fail, so the gate fails.
			failed = true;
		}
		if (options.check && config !== null) {
			const probe = await probeService(
				config,
				options.fetch,
				options.timeoutMs
			);
			failed ||= !probe.ok;
			reports.push({ ...report, probe });
		} else {
			reports.push(report);
		}
	}
	if (options.json) {
		writeLine(
			io.stdout,
			toJson({
				data: {
					npmNote,
					npmPublishedVersion,
					services: reports,
				},
				meta: null,
			})
		);
	} else {
		writeLine(
			io.stdout,
			reports.map((report) => humanReport(report, io.program)).join("\n")
		);
		if (npmNote !== null) {
			writeLine(io.stdout, `\nnote: ${npmNote}`);
		}
	}
	return failed ? EXIT_CODES.error : EXIT_CODES.ok;
}
