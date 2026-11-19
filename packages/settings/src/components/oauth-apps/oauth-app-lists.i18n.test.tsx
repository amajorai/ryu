import { describe, expect, test } from "bun:test";
import type { OAuthApp, OwnedOAuthApp } from "@ryu/auth/oauth-contract";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizedOAuthAppList } from "./authorized-oauth-app-list.tsx";
import { OAuthAppRow } from "./oauth-app-row.tsx";

// Scope and redirect lists used to be joined with an English ", " inside
// translated rows. These render the real rows and check each list is joined
// the way the reader's language writes one.

const AUTHORIZED = "{scopeList} · Authorized {relativeTime}";
// Stub rows standing in for the catalog rows the coordinator generates.
const OVERLAYS = {
	ar: { [AUTHORIZED]: "{scopeList} · مُصرَّح {relativeTime}", None: "لا شيء" },
	de: {
		[AUTHORIZED]: "{scopeList} · Autorisiert {relativeTime}",
		None: "Keine",
	},
	ja: { [AUTHORIZED]: "{scopeList} · {relativeTime}に承認", None: "なし" },
};

function render(locale: string, element: ReactElement): string {
	return renderToStaticMarkup(
		<I18nProvider
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			{element}
		</I18nProvider>
	);
}

function authorizedDescription(locale: string): string {
	const app: OAuthApp = {
		clientId: "client-1",
		clientName: "Example CLI",
		grantedAt: new Date().toISOString(),
		icon: null,
		kind: "oauth",
		scopes: "profile:read sessions:read billing:write",
	};
	const html = render(
		locale,
		<AuthorizedOAuthAppList
			apps={[app]}
			confirmRevoke={null}
			isRevoking={false}
			onConfirmRevoke={() => undefined}
			onRevoke={() => undefined}
			onStartRevoke={() => undefined}
		/>
	);
	return html.replace(/<[^>]+>/g, "\n");
}

/** The `<dd>` values of the row's details: client id, redirects, scopes. */
function ownedDetails(locale: string, scopes: string[]): string[] {
	const app: OwnedOAuthApp = {
		applicationType: "web",
		clientId: "client-1",
		clientName: "Example",
		clientType: "public",
		createdAt: null,
		disabled: false,
		redirectUris: ["https://a.example/cb", "https://b.example/cb"],
		scopes,
	};
	const html = render(
		locale,
		<OAuthAppRow
			app={app}
			onAction={() => undefined}
			onCancelAction={() => undefined}
			pendingAction={null}
		/>
	);
	return [...html.matchAll(/<dd[^>]*>([^<]*)<\/dd>/g)].map(
		(match) => match[1] ?? ""
	);
}

const SCOPES = ["profile:read", "sessions:read"];

describe("authorized OAuth app scopes", () => {
	test("English lists the scopes as a sentence list", () => {
		expect(authorizedDescription("en")).toContain(
			"Profile · read, Sessions · read, and Billing · write · Authorized"
		);
	});

	test("Japanese joins the scopes with 、, not an English comma", () => {
		const text = authorizedDescription("ja");
		expect(text).toContain("Profile · read、Sessions · read、Billing · write");
		expect(text).not.toContain(", ");
	});

	test("Arabic and German use their own list words", () => {
		expect(authorizedDescription("ar")).not.toContain(", ");
		expect(authorizedDescription("de")).toContain(
			"Profile · read, Sessions · read und Billing · write · Autorisiert"
		);
	});
});

describe("owned OAuth app details", () => {
	test("English lists redirects and scopes, and says None for no scopes", () => {
		expect(ownedDetails("en", SCOPES)).toEqual([
			"client-1",
			"https://a.example/cb and https://b.example/cb",
			"Profile · read and Sessions · read",
		]);
		expect(ownedDetails("en", []).at(-1)).toBe("None");
	});

	test("Japanese lists have no English comma and the empty value is translated", () => {
		const [, redirects, scopes] = ownedDetails("ja", SCOPES);
		expect(redirects).toBe("https://a.example/cb、https://b.example/cb");
		expect(scopes).toBe("Profile · read、Sessions · read");
		expect(ownedDetails("ja", []).at(-1)).toBe("なし");
	});

	test("Arabic and German translate the empty value", () => {
		expect(ownedDetails("ar", []).at(-1)).toBe("لا شيء");
		expect(ownedDetails("de", []).at(-1)).toBe("Keine");
	});
});
