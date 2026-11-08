import { expect, test } from "bun:test";
import type { VaultBrokerService } from "@/src/lib/api/vault-broker.ts";
import {
	emptyServiceForm,
	serviceFormFrom,
	serviceFormFromHost,
	serviceInputFrom,
	serviceNameForHost,
} from "./vault-broker-service-form.ts";

const STORED: VaultBrokerService = {
	allowInsecureHttp: true,
	auth: {
		header: "x-api-key",
		prefix: "Key ",
		type: "api_key",
		value: "secret:ANTHROPIC_API_KEY",
	},
	boxRelay: true,
	createdAt: "2026-10-01T00:00:00Z",
	description: "Claude API",
	enabled: false,
	environment: "prod",
	host: "api.anthropic.com",
	name: "anthropic",
	notes: "kept",
	pathPrefix: "/v1",
	port: 8443,
	substitutions: [
		{ in: ["header"], placeholder: "__ORG__", ref: "secret:ORG_ID" },
	],
	updatedAt: "2026-10-02T00:00:00Z",
};

test("a stored service round-trips through the form, keeping fields the form does not edit", () => {
	const form = serviceFormFrom(STORED);
	expect(form).toMatchObject({
		authType: "api_key",
		description: "Claude API",
		enabled: false,
		header: "x-api-key",
		port: "8443",
		prefix: "Key ",
		value: "secret:ANTHROPIC_API_KEY",
	});
	expect(serviceInputFrom(form, STORED)).toEqual({
		input: {
			allowInsecureHttp: true,
			auth: STORED.auth as NonNullable<VaultBrokerService["auth"]>,
			// Saving from the editor must not switch off the Box relay.
			boxRelay: true,
			description: "Claude API",
			enabled: false,
			environment: "prod",
			host: "api.anthropic.com",
			name: "anthropic",
			notes: "kept",
			pathPrefix: "/v1",
			port: 8443,
			substitutions: STORED.substitutions,
		},
	});
});

test("a new bearer service trims and lowercases, defaults the path, and sends no port", () => {
	const form = {
		...emptyServiceForm("default"),
		host: " API.Example.com. ",
		name: "example",
		pathPrefix: "",
		token: " secret:EXAMPLE_TOKEN ",
	};
	expect(serviceInputFrom(form)).toEqual({
		input: {
			auth: { token: "secret:EXAMPLE_TOKEN", type: "bearer" },
			description: "",
			enabled: true,
			environment: "default",
			host: "api.example.com",
			name: "example",
			pathPrefix: "/",
		},
	});
});

test("custom headers parse one Name: template per line", () => {
	const form = {
		...emptyServiceForm("default"),
		authType: "custom" as const,
		customHeaders:
			"X-Key: {{secret:KEY}}\n\n Authorization: Token {{secret:TOKEN}} ",
		host: "h.example",
		name: "h",
	};
	const built = serviceInputFrom(form);
	expect("input" in built && built.input.auth).toEqual({
		headers: {
			Authorization: "Token {{secret:TOKEN}}",
			"X-Key": "{{secret:KEY}}",
		},
		type: "custom",
	});
	expect(serviceInputFrom({ ...form, customHeaders: "no colon here" })).toEqual(
		{ error: "Write each header as Name: {{secret:REF}}." }
	);
});

test("each invalid field names its problem before anything is sent", () => {
	const base = {
		...emptyServiceForm("default"),
		host: "api.example.com",
		name: "ok",
		token: "secret:T",
	};
	const cases: [Partial<typeof base>, string][] = [
		[{ name: "Bad Name" }, "lowercase"],
		[{ host: "https://x.example/path" }, "host name"],
		[{ port: "70000" }, "1 to 65535"],
		[{ pathPrefix: "v1" }, "starts with /"],
		[{ token: "  " }, "token reference is required"],
	];
	for (const [patch, message] of cases) {
		const built = serviceInputFrom({ ...base, ...patch });
		expect("error" in built && built.error).toContain(message);
	}
	expect(
		serviceInputFrom({ ...base, authType: "api_key", header: "bad header" })
	).toEqual({ error: "Enter a valid header name." });
	expect(
		serviceInputFrom({ ...base, authType: "basic", username: "u" })
	).toEqual({ error: "The password reference is required." });
});

test("an OAuth binding is kept on edit but cannot be authored", () => {
	const oauth = {
		...STORED,
		auth: {
			plugin: "@ryu/linear",
			resource: "https://mcp.linear.app/sse",
			server: "linear",
			type: "oauth" as const,
		},
	};
	const form = serviceFormFrom(oauth);
	expect(form.authType).toBe("oauth");
	const built = serviceInputFrom(form, oauth);
	expect("input" in built && built.input.auth).toEqual(oauth.auth);
	expect(serviceInputFrom(form)).toEqual({
		error: "OAuth services are added from a connected plugin.",
	});
});

test("a discovered host suggests a name and keeps a non-default port", () => {
	expect(serviceNameForHost("api.stripe.com")).toBe("stripe");
	expect(serviceNameForHost("www.api.example.co")).toBe("example");
	expect(serviceNameForHost("localhost")).toBe("localhost");
	expect(serviceNameForHost("*.svc.example.com")).toBe("svc");
	expect(
		serviceFormFromHost({
			environment: "prod",
			host: "api.stripe.com",
			lastSeen: 0,
			port: 443,
			requests: 3,
		})
	).toMatchObject({ environment: "prod", host: "api.stripe.com", port: "" });
	expect(
		serviceFormFromHost({
			environment: "prod",
			host: "10.0.0.5",
			lastSeen: 0,
			port: 8080,
			requests: 1,
		}).port
	).toBe("8080");
});
