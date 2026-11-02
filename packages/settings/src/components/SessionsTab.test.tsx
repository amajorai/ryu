import { describe, expect, test } from "bun:test";
import type { DeviceLimitSummary } from "@ryu/auth/lib/device-limits";
import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionWithSurface } from "../utils/device-limits-api.ts";
import { SessionsTab } from "./SessionsTab.tsx";

// Static markup over a pre-seeded query cache: no network, no DOM. Covers
// locale-aware session ages (Intl.RelativeTimeFormat in the UI language, not
// date-fns's English "… ago"), the device-limit surface label on each row and
// the enforced usage line.

const HOUR_MS = 60 * 60 * 1000;

const sessions: SessionWithSurface[] = [
	{
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 86_400_000),
		id: "desktop-session",
		isCurrent: false,
		surface: "desktop",
		userAgent: "Ryu Desktop",
		userId: "u1",
	},
	{
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 86_400_000),
		id: "legacy-session",
		isCurrent: true,
		userAgent: "Mozilla/5.0 Chrome/130",
		userId: "u1",
	},
];

function summary(enforced: boolean): DeviceLimitSummary {
	return {
		enforced,
		surfaces: [
			{ count: 1, label: "Web browsers", limit: 10, surface: "web" },
			{ count: 1, label: "Ryu Desktop", limit: 5, surface: "desktop" },
			{ count: 0, label: "CLI and MCP", limit: 5, surface: "cli" },
		],
	};
}

function queryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
}

function renderLocale(locale: string): string {
	const client = queryClient();
	client.setQueryData(["sessions"], {
		sessions: [
			{
				createdAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
				current: false,
				id: "s1",
				ipAddress: "203.0.113.4",
				userAgent: null,
			},
		],
	});
	return renderToStaticMarkup(
		<I18nProvider initialLocale={locale} initialPackId={null}>
			<QueryClientProvider client={client}>
				<SessionsTab />
			</QueryClientProvider>
		</I18nProvider>
	);
}

function render(limits: DeviceLimitSummary | null): string {
	const client = queryClient();
	client.setQueryData(["sessions"], { sessions });
	client.setQueryData(["sessions", "device-limits"], limits);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<SessionsTab />
		</QueryClientProvider>
	);
}

describe("SessionsTab session ages", () => {
	test("session ages read in English under en", () => {
		expect(renderLocale("en")).toContain("3 hours ago");
	});

	test("session ages follow the UI locale", () => {
		const html = renderLocale("ja");
		expect(html).toContain("3 時間前");
		expect(html).not.toContain("ago");
	});
});

describe("SessionsTab device surfaces", () => {
	test("each row names the surface it counts against when the server sent one", () => {
		const html = render(null);
		expect(html).toContain("Ryu Desktop · ");
		expect(html).toContain("This device");
		expect(html).not.toContain("Web browsers · ");
	});

	test("an enforced account sees usage for surfaces in use only", () => {
		const html = render(summary(true));
		expect(html).toContain("Web browsers: 1 of 10 · Ryu Desktop: 1 of 5");
		expect(html).not.toContain("CLI and MCP: 0 of 5");
	});

	test("without enforcement there is no usage line", () => {
		const html = render(summary(false));
		expect(html).not.toContain("device-limit-usage");
		expect(html).not.toContain("1 of 10");
	});
});
