import { describe, expect, test } from "bun:test";
import type { OwnedOAuthApp } from "@ryu/auth/oauth-contract";
import { I18nProvider, type LiteralMessage } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	SupportAccessAuditEntry,
	SupportAccessStatus,
} from "../utils/api-client.ts";
import { OAuthAppRow } from "./oauth-apps/oauth-app-row.tsx";
import { SupportAccessTab } from "./SupportAccessTab.tsx";
import {
	oauthApplicationTypeLabel,
	supportScopeLabel,
	supportScopeList,
	supportSessionEndLabel,
} from "./settings-protocol-labels.ts";

// Settings rows used to splice raw protocol ids ("billing, sync-status",
// "expired", "native") into translated sentences. These render the real
// components under Japanese and check the ids never reach the reader.

// The labels carry no placeholders, so the source text is the English output.
const english: LiteralMessage = (message) => message;

function queryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
}

function textOf(markup: string): string {
	return markup.replace(/<[^>]+>/g, " ");
}

function renderSupportAccess(locale: string): string {
	const client = queryClient();
	const status: SupportAccessStatus = {
		grant: {
			activeSession: false,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(),
			id: "g1",
			note: null,
			revokedAt: null,
			scopes: ["billing", "sync-status"],
			status: "active",
		},
		maxDurationMinutes: 60,
	};
	const audit: SupportAccessAuditEntry[] = [
		{
			actorEmail: "agent@example.com",
			endedAt: new Date().toISOString(),
			endedReason: "expired",
			id: "a1",
			reason: "Ticket 42",
			scopes: ["billing"],
			startedAt: new Date(Date.now() - 3_600_000).toISOString(),
		},
	];
	client.setQueryData(["support-access"], status);
	client.setQueryData(["support-access-audit"], { audit });
	return renderToStaticMarkup(
		<I18nProvider initialLocale={locale} initialPackId={null}>
			<QueryClientProvider client={client}>
				<SupportAccessTab />
			</QueryClientProvider>
		</I18nProvider>
	);
}

function renderOAuthRow(locale: string): string {
	const app: OwnedOAuthApp = {
		applicationType: "native",
		clientId: "client-1",
		clientName: "Example CLI",
		clientType: "confidential",
		createdAt: new Date().toISOString(),
		disabled: false,
		redirectUris: ["http://127.0.0.1/callback"],
		scopes: ["openid"],
	};
	return renderToStaticMarkup(
		<I18nProvider initialLocale={locale} initialPackId={null}>
			<OAuthAppRow
				app={app}
				onAction={() => undefined}
				onCancelAction={() => undefined}
				pendingAction={null}
			/>
		</I18nProvider>
	);
}

describe("settings protocol labels", () => {
	test("scope ids map to labels and join as a reader's list", () => {
		expect(supportScopeLabel(english, "sync-status")).toBe("Sync status");
		expect(supportScopeLabel(english, "future-scope")).toBe("future-scope");
		expect(supportScopeList(english, ["billing", "sync-status"], "en")).toBe(
			"Billing and Sync status"
		);
		expect(supportScopeList(english, [], "en")).toBe("none");
	});

	test("end reasons and application types never return the raw id", () => {
		expect(supportSessionEndLabel(english, "expired")).toBe("Expired");
		expect(supportSessionEndLabel(english, "stopped")).toBe("Stopped");
		expect(supportSessionEndLabel(english, "revoked")).toBe("Revoked");
		expect(supportSessionEndLabel(english, null)).toBe("Ended");
		expect(supportSessionEndLabel(english, "something-new")).toBe("Ended");
		expect(oauthApplicationTypeLabel(english, "native")).toBe("Native app");
		expect(oauthApplicationTypeLabel(english, "web")).toBe("Web app");
	});

	test("SupportAccessTab under ja shows translated scopes and end reason", () => {
		const text = textOf(renderSupportAccess("ja"));
		expect(text).not.toContain("billing");
		expect(text).not.toContain("sync-status");
		expect(text).not.toMatch(/\bexpired\b/);
		// Labels the settings catalog subset already carries are translated;
		// the rest stay readable English labels until the catalogs regenerate.
		expect(text).toContain("請求");
		expect(text).toMatch(/同期状況|Sync status/);
		expect(text).toMatch(/期限切れ|Expired/);
	});

	test("SupportAccessTab under ar and de lists localized scope labels", () => {
		for (const [locale, billing] of [
			["ar", "الفوترة"],
			["de", "Abrechnung"],
		] as const) {
			const text = textOf(renderSupportAccess(locale));
			expect(text).not.toContain("billing");
			expect(text).not.toContain("sync-status");
			expect(text).not.toMatch(/\bexpired\b/);
			expect(text).toContain(billing);
		}
	});

	test("OAuthAppRow under ar and de does not splice the raw application type", () => {
		for (const locale of ["ar", "de"]) {
			expect(textOf(renderOAuthRow(locale))).not.toMatch(/\bnative\b/);
		}
	});

	test("SupportAccessTab under en lists scope labels, not ids", () => {
		const text = textOf(renderSupportAccess("en"));
		expect(text).toContain("Billing and Sync status");
		expect(text).toContain("Expired");
	});

	test("OAuthAppRow under ja does not splice the raw application type", () => {
		expect(textOf(renderOAuthRow("ja"))).not.toMatch(/\bnative\b/);
		expect(textOf(renderOAuthRow("en"))).toContain("Native app");
	});
});
