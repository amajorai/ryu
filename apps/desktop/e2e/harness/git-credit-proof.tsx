declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { GitSettingsSection } from "../../src/components/gateway/GitSettingsSection.tsx";
import type { GatewayGovernanceSnapshot } from "../../src/lib/api/governance.ts";
import "../../src/index.css";

const PREFERENCE_KEY = "git-credit-ryu";
const PROOF_STORAGE_KEY = "proof-git-credit-ryu";
const PROOF_WRITES_KEY = "proof-git-credit-ryu-writes";
const TARGET = { token: null, url: window.location.origin };
const theme =
	new URLSearchParams(window.location.search).get("theme") === "light"
		? "light"
		: "dark";

const governance: GatewayGovernanceSnapshot = {
	layers: [
		{ revision: 1, scope: "node", values: {}, writable: true },
		{ revision: 1, scope: "organization", values: {}, writable: false },
		{ revision: 1, scope: "team", values: {}, writable: false },
		{ revision: 1, scope: "user", values: {}, writable: true },
	],
	schemaVersion: 1,
};

const preferenceWriteSchema = z.object({ value: z.string() });

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

// A stand-in for Core's preference store: the saved value lives in session
// storage so it survives a reload, and every write is recorded for the spec.
window.fetch = (input, init) => {
	const requestUrl =
		input instanceof Request
			? input.url
			: input instanceof URL
				? input.href
				: input;
	const url = new URL(requestUrl);
	const method = (init?.method ?? "GET").toUpperCase();

	if (url.pathname === "/api/gateway/governance") {
		return Promise.resolve(jsonResponse(governance));
	}
	if (url.pathname === `/api/preferences/${PREFERENCE_KEY}`) {
		if (method === "PUT") {
			const body = preferenceWriteSchema.safeParse(
				JSON.parse(typeof init?.body === "string" ? init.body : "{}")
			);
			if (body.success) {
				const writes: string[] = JSON.parse(
					sessionStorage.getItem(PROOF_WRITES_KEY) ?? "[]"
				);
				writes.push(body.data.value);
				sessionStorage.setItem(PROOF_WRITES_KEY, JSON.stringify(writes));
				sessionStorage.setItem(PROOF_STORAGE_KEY, body.data.value);
			}
			return Promise.resolve(jsonResponse({ ok: true }));
		}

		const value = sessionStorage.getItem(PROOF_STORAGE_KEY);
		return Promise.resolve(
			value === null
				? jsonResponse({ error: "preference not set" }, 404)
				: jsonResponse({ key: PREFERENCE_KEY, value })
		);
	}

	return Promise.resolve(jsonResponse({}));
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Proof() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme={theme}
			enableSystem={false}
			forcedTheme={theme}
		>
			<I18nProvider>
				<QueryClientProvider client={queryClient}>
					<main className="min-h-screen bg-background px-8 py-10 text-foreground">
						<div className="mx-auto max-w-5xl">
							<GitSettingsSection canConfigure target={TARGET} />
						</div>
					</main>
				</QueryClientProvider>
			</I18nProvider>
		</ThemeProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Proof />);
