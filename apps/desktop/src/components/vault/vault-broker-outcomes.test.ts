import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { VaultBrokerLogRow } from "@/src/lib/api/vault-broker-console.ts";
import { logDetail } from "./VaultBrokerActivity.tsx";
import { brokerOutcomeLabel } from "./vault-broker-outcomes.ts";
import { whenLabel } from "./vault-broker-summary.ts";

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

// Stub packs: the generated catalogs do not carry these strings yet.
function packTranslator(pack: Record<string, string>): LiteralMessage {
	return (source, values) =>
		formatMessage(pack[source] ?? source, values ?? {});
}

const ja = packTranslator({
	"card approval required": "カードの承認が必要",
	forbidden: "禁止",
	"no service": "サービスなし",
	refused: "拒否",
	"{ms} ms": "{ms} ミリ秒",
});

const ar = packTranslator({
	forwarded: "تمت إعادة التوجيه",
	"OAuth reconnection required": "يلزم إعادة اتصال OAuth",
});

const de = packTranslator({
	"rate limited": "ratenbegrenzt",
	"proxy authentication required": "Proxy-Anmeldung erforderlich",
});

const AT = "2026-11-09T10:15:00.000Z";

function row(overrides: Partial<VaultBrokerLogRow>): VaultBrokerLogRow {
	return {
		at: AT,
		environment: "prod",
		host: "api.github.com",
		id: 1,
		latencyMs: 42,
		method: "GET",
		outcome: "forwarded",
		path: "/user",
		port: 443,
		scheme: "https",
		service: "github",
		sessionId: null,
		status: 200,
		...overrides,
	};
}

test("each Core outcome code reads as a phrase, not the program code", () => {
	const expected: Record<string, string> = {
		absolute_form_required: "full URL required",
		card_approval_required: "card approval required",
		credential_approval_required: "credential approval required",
		forbidden: "forbidden",
		forwarded: "forwarded",
		intercepted: "inspected tunnel opened",
		oauth_connect_required: "OAuth connection required",
		oauth_reconnect_required: "OAuth reconnection required",
		proxy_auth_required: "proxy authentication required",
		rate_limited: "rate limited",
		tunneled: "tunnel opened",
	};
	for (const [code, label] of Object.entries(expected)) {
		expect(brokerOutcomeLabel(code, english)).toBe(label);
	}
});

test("an outcome code the table does not know reads as refused", () => {
	expect(brokerOutcomeLabel("netguard_blocked", english)).toBe("refused");
	expect(brokerOutcomeLabel("vault_sealed", ja)).toBe("拒否");
});

test("outcome labels follow the active language", () => {
	expect(brokerOutcomeLabel("card_approval_required", ja)).toBe(
		"カードの承認が必要"
	);
	expect(brokerOutcomeLabel("forwarded", ar)).toBe("تمت إعادة التوجيه");
	expect(brokerOutcomeLabel("oauth_reconnect_required", ar)).toBe(
		"يلزم إعادة اتصال OAuth"
	);
	expect(brokerOutcomeLabel("rate_limited", de)).toBe("ratenbegrenzt");
	expect(brokerOutcomeLabel("proxy_auth_required", de)).toBe(
		"Proxy-Anmeldung erforderlich"
	);
});

test("the request-log detail line is translated piece by piece", () => {
	expect(logDetail(row({}), english)).toBe(
		`${whenLabel(AT)} · github · forwarded · 42 ms`
	);
	expect(logDetail(row({ outcome: "forbidden", service: null }), ja)).toBe(
		`${whenLabel(AT)} · サービスなし · 禁止 · 42 ミリ秒`
	);
	expect(logDetail(row({ outcome: "broker_internal" }), ja)).toBe(
		`${whenLabel(AT)} · github · 拒否 · 42 ミリ秒`
	);
});
