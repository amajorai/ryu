// Form state for the broker service editor: building it from a stored
// service or a discovered host, and turning it back into the body Core takes.
// Credential fields hold references (`secret:NAME`, `op://…`, `bws://…`), never
// values. Fields the form does not edit (substitutions, notes, plain-HTTP
// opt-in, an OAuth binding) are carried over unchanged from the original.

import type {
	VaultBrokerAuth,
	VaultBrokerAuthType,
	VaultBrokerService,
	VaultBrokerServiceInput,
} from "@/src/lib/api/vault-broker.ts";
import type { VaultBrokerDiscoveredHost } from "@/src/lib/api/vault-broker-console.ts";

export interface BrokerServiceForm {
	authType: VaultBrokerAuthType;
	/** `Header: template` lines for `custom` auth. */
	customHeaders: string;
	description: string;
	enabled: boolean;
	environment: string;
	header: string;
	host: string;
	name: string;
	password: string;
	pathPrefix: string;
	port: string;
	prefix: string;
	token: string;
	username: string;
	value: string;
}

/** The auth kinds the editor can author. OAuth services are created from a
 *  plugin's connection and only kept, not authored, here. */
export const EDITABLE_AUTH_TYPES = [
	{ label: "Bearer token", value: "bearer" },
	{ label: "API key header", value: "api_key" },
	{ label: "Basic auth", value: "basic" },
	{ label: "Custom headers", value: "custom" },
	{ label: "No credential (placeholders only)", value: "passthrough" },
] satisfies { label: string; value: VaultBrokerAuthType }[];

const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;
const HOST_PATTERN =
	/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_PORT = 65_535;

export function emptyServiceForm(environment: string): BrokerServiceForm {
	return {
		authType: "bearer",
		customHeaders: "",
		description: "",
		enabled: true,
		environment,
		header: "",
		host: "",
		name: "",
		password: "",
		pathPrefix: "/",
		port: "",
		prefix: "",
		token: "",
		username: "",
		value: "",
	};
}

function formAuth(form: BrokerServiceForm, auth: VaultBrokerAuth): void {
	form.authType = auth.type;
	switch (auth.type) {
		case "bearer":
			form.token = auth.token;
			break;
		case "basic":
			form.username = auth.username;
			form.password = auth.password;
			break;
		case "api_key":
			form.header = auth.header;
			form.value = auth.value;
			form.prefix = auth.prefix ?? "";
			break;
		case "custom":
			form.customHeaders = Object.entries(auth.headers)
				.map(([name, template]) => `${name}: ${template}`)
				.join("\n");
			break;
		default:
			break;
	}
}

export function serviceFormFrom(
	service: VaultBrokerService
): BrokerServiceForm {
	const form: BrokerServiceForm = {
		...emptyServiceForm(service.environment),
		description: service.description ?? "",
		enabled: service.enabled,
		host: service.host,
		name: service.name,
		pathPrefix: service.pathPrefix,
		port: service.port ? String(service.port) : "",
	};
	if (service.auth) {
		formAuth(form, service.auth);
	}
	return form;
}

/** A service name from a host: its first label that is not a generic one
 *  (`api.stripe.com` → `stripe`), cut to Core's name rules. */
export function serviceNameForHost(host: string): string {
	const generic = new Set(["api", "www", "app", "rest", "*"]);
	const labels = host.toLowerCase().split(".").filter(Boolean);
	const meaningful =
		labels.length > 2
			? labels.slice(0, -1).find((label) => !generic.has(label))
			: labels[0];
	const name = (meaningful ?? labels[0] ?? "service")
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return name || "service";
}

export function serviceFormFromHost(
	discovered: VaultBrokerDiscoveredHost
): BrokerServiceForm {
	return {
		...emptyServiceForm(discovered.environment),
		host: discovered.host,
		name: serviceNameForHost(discovered.host),
		port:
			discovered.port && discovered.port !== 443 ? String(discovered.port) : "",
	};
}

function parseHeaders(
	text: string
): { headers: Record<string, string> } | { error: string } {
	const headers: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon).trim() : "";
		const template = colon > 0 ? line.slice(colon + 1).trim() : "";
		if (!(HEADER_NAME.test(name) && template)) {
			return { error: "Write each header as Name: {{secret:REF}}." };
		}
		headers[name] = template;
	}
	if (Object.keys(headers).length === 0) {
		return { error: "Add at least one header." };
	}
	return { headers };
}

type AuthResult = { auth: VaultBrokerAuth } | { error: string };

/** A trimmed field, or `null` when it is blank. */
function required(value: string): string | null {
	return value.trim() || null;
}

function authFrom(
	form: BrokerServiceForm,
	original?: VaultBrokerService
): AuthResult {
	switch (form.authType) {
		case "bearer": {
			const token = required(form.token);
			return token
				? { auth: { token, type: "bearer" } }
				: { error: "The token reference is required." };
		}
		case "basic": {
			const username = required(form.username);
			const password = required(form.password);
			if (!username) {
				return { error: "The username is required." };
			}
			return password
				? { auth: { password, type: "basic", username } }
				: { error: "The password reference is required." };
		}
		case "api_key": {
			const header = form.header.trim();
			if (!HEADER_NAME.test(header)) {
				return { error: "Enter a valid header name." };
			}
			const value = required(form.value);
			if (!value) {
				return { error: "The key reference is required." };
			}
			return {
				auth: form.prefix
					? { header, prefix: form.prefix, type: "api_key", value }
					: { header, type: "api_key", value },
			};
		}
		case "custom": {
			const parsed = parseHeaders(form.customHeaders);
			return "error" in parsed
				? parsed
				: { auth: { headers: parsed.headers, type: "custom" } };
		}
		case "oauth":
			return original?.auth?.type === "oauth"
				? { auth: original.auth }
				: { error: "OAuth services are added from a connected plugin." };
		default:
			return { auth: { type: "passthrough" } };
	}
}

/** The body for create or replace, or the first problem in the form. */
export function serviceInputFrom(
	form: BrokerServiceForm,
	original?: VaultBrokerService
): { input: VaultBrokerServiceInput } | { error: string } {
	const name = form.name.trim();
	if (!NAME_PATTERN.test(name)) {
		return {
			error: "Use 1-64 lowercase letters, digits, dashes or underscores.",
		};
	}
	const host = form.host.trim().replace(/\.$/, "").toLowerCase();
	if (!HOST_PATTERN.test(host)) {
		return { error: "Enter a host name such as api.example.com." };
	}
	let port: number | undefined;
	if (form.port.trim()) {
		port = Number(form.port.trim());
		if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
			return { error: "Ports run from 1 to 65535." };
		}
	}
	const pathPrefix = form.pathPrefix.trim() || "/";
	if (!pathPrefix.startsWith("/")) {
		return { error: "The path prefix starts with /." };
	}
	const built = authFrom(form, original);
	if ("error" in built) {
		return built;
	}
	const input: VaultBrokerServiceInput = {
		auth: built.auth,
		description: form.description.trim(),
		enabled: form.enabled,
		environment: form.environment,
		host,
		name,
		pathPrefix,
	};
	if (port !== undefined) {
		input.port = port;
	}
	if (original) {
		input.allowInsecureHttp = original.allowInsecureHttp ?? false;
		// Not authored here: a replace must keep it, or saving a service from
		// the editor would silently stop its relay into cloud-task Boxes.
		input.boxRelay = original.boxRelay ?? false;
		input.notes = original.notes ?? "";
		input.substitutions = original.substitutions ?? [];
	}
	return { input };
}
