import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { toError } from "./marketplace-http.ts";
import { previewPrivatePackageShareCode } from "./marketplace-private-share.ts";

// Fallback copy the marketplace client makes up itself must reach the reader
// in their language: the Stripe refusal when the server sends no message, and
// the default name of a private package whose listing has none.

const GERMAN: Readonly<Record<string, string>> = {
	"Private package": "Privates Paket",
	"Purchase is unavailable: Stripe is not configured.":
		"Kauf nicht verfügbar: Stripe ist nicht konfiguriert.",
	"Request failed: {status}": "Anfrage fehlgeschlagen: {status}",
};

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(GERMAN[source] ?? source, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

test("the Stripe refusal without a server message is translated", async () => {
	registerActiveI18nRuntime(german);
	const error = await toError(Response.json({}, { status: 503 }));
	expect(error.kind).toBe("stripe");
	expect(error.message).toBe(
		"Kauf nicht verfügbar: Stripe ist nicht konfiguriert."
	);
});

test("an unmapped failure without a server message is translated", async () => {
	registerActiveI18nRuntime(german);
	const error = await toError(new Response("oops", { status: 500 }));
	expect(error.kind).toBe("unknown");
	expect(error.message).toBe("Anfrage fehlgeschlagen: 500");
});

test("a private package without a name gets a translated default name", async () => {
	registerActiveI18nRuntime(german);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = createFetchFixture(originalFetch, async () =>
		Response.json({
			audience: "shareable",
			listing: { id: "acme/unnamed", kind: "workflow", version: "1.0.0" },
		})
	);
	try {
		const preview = await previewPrivatePackageShareCode("7K4M-X2QP-9F6D");
		expect(preview.name).toBe("Privates Paket");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
