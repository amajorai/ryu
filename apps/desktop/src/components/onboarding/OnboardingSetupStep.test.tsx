import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Run separately: the real picker reads browser-local settings during render.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
await import("react");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { ThemeProvider } = await import("next-themes");
const { MemoryRouter } = await import("react-router-dom");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { EMPTY_AGENT_SELECTION } = await import("@/src/lib/api/preferences.ts");
const { OnboardingSetupStep } = await import("./OnboardingSetupStep.tsx");

beforeEach(() => localStorage.clear());

import type { PiProvider } from "@/src/lib/api/pi-config.ts";

const baseProps = {
	agentSuggestions: [],
	agentSuggestionsError: null,
	agentSuggestionsIdentityModes: new Map(),
	agentSuggestionsReviewed: new Set<string>(),
	agentSuggestionsSelected: new Set<string>(),
	agentSuggestionsSubmitting: false,
	allowedAgentIds: ["ryu"],
	alreadyBuilt: false,
	autoImport: true,
	cloudSelection: EMPTY_AGENT_SELECTION,
	connectingToolkit: null,
	connectionQuery: "",
	connections: [],
	connectionsCheckFailed: false,
	defaultProviderIds: [],
	freeCloud: false,
	importing: false,
	localSelection: EMPTY_AGENT_SELECTION,
	onBackgroundProfile: () => undefined,
	onCancelProfile: () => undefined,
	onChooseOrganization: () => undefined,
	onCloudSelectionChange: () => undefined,
	onConfigureProvider: () => undefined,
	onConnectToolkit: async () => undefined,
	onContinue: () => undefined,
	onContinueBackgroundProfile: () => undefined,
	onCreateAgentSuggestions: () => undefined,
	onImportThreads: () => undefined,
	onLocalSelectionChange: () => undefined,
	onSearchConnections: () => undefined,
	onReviewAgentSuggestion: () => undefined,
	onAgentSuggestionIdentityModeChange: () => undefined,
	onSkip: () => undefined,
	onToggleAgentSuggestion: () => undefined,
	onToggleAutoImport: () => undefined,
	organizations: [],
	piProviders: [],
	nodeSetupKind: null,
	profileJob: null,
	profileStartedAt: Date.now() - 30_000,
	providerBusyId: null,
	selectedOrganizationId: null,
	target: { token: null, url: "http://127.0.0.1:7980", userJwt: null },
	threadGroups: [],
	toolkits: [],
};

function provider(overrides: Partial<PiProvider>): PiProvider {
	return {
		api: "openai-completions",
		authEnv: "API_KEY",
		authKind: "api-key",
		configured: false,
		custom: false,
		id: "openai",
		label: "OpenAI",
		routing: "gateway",
		suggestedModels: [],
		...overrides,
	};
}

describe("desktop onboarding profile handoff", () => {
	for (const kind of ["local-default", "cloud-default"] as const) {
		test(`${kind} locks the real selection control during the parent save and enables it again after settling`, () => {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			const renderSelection = (busy: boolean) =>
				renderToStaticMarkup(
					<QueryClientProvider client={client}>
						<I18nProvider>
							<AppSurfaceProvider surface="desktop">
								<EntitlementProvider>
									<ThemeProvider
										attribute="class"
										defaultTheme="dark"
										enableSystem
									>
										<MemoryRouter>
											<OnboardingSetupStep
												{...baseProps}
												busy={busy}
												kind={kind}
												profileJob={null}
											/>
										</MemoryRouter>
									</ThemeProvider>
								</EntitlementProvider>
							</AppSurfaceProvider>
						</I18nProvider>
					</QueryClientProvider>
				);
			const label =
				kind === "local-default"
					? "Choose default local agent"
					: "Choose default cloud agent";
			const selectionButton = (html: string) =>
				html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
			const pending = selectionButton(renderSelection(true));
			const settled = selectionButton(renderSelection(false));
			expect(pending).toBeDefined();
			expect(pending).toContain('disabled=""');
			expect(settled).toBeDefined();
			expect(settled).not.toContain('disabled=""');
		});
	}
	test("imports keep auto-import consent locked during a parent save and restore its current checked state", () => {
		const renderImport = (busy: boolean) =>
			renderToStaticMarkup(
				<OnboardingSetupStep
					{...baseProps}
					busy={busy}
					kind="imports"
					profileJob={null}
				/>
			);
		const switchControl = (html: string) =>
			html.match(/<span[^>]*role="switch"[^>]*>/)?.[0];
		const pending = switchControl(renderImport(true));
		const settled = switchControl(renderImport(false));
		expect(pending).toBeDefined();
		expect(pending).toContain('aria-disabled="true"');
		expect(pending).toContain('aria-checked="true"');
		expect(settled).toBeDefined();
		expect(settled).not.toContain('aria-disabled="true"');
		expect(settled).toContain('aria-checked="true"');
	});
	test("keeps a background build on the profile screen", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="profile"
				profileJob={{
					agentSuggestions: [],
					background: true,
					conversationId: null,
					error: null,
					id: "job-1",
					materialized: false,
					startedAtMs: Date.now() - 30_000,
					state: "building",
				}}
				profileStartedAt={Date.now() - 30_000}
			/>
		);

		expect(html).toContain("Continue setup");
		expect(html).toContain("Wait here to review agent drafts");
		expect(html).not.toContain("Run in background");
		expect(html).not.toContain("Open profile chat later");
	});

	test("offers Run in background for a long foreground build that is already materializing", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="profile"
				profileJob={{
					agentSuggestions: [],
					background: false,
					conversationId: "profile-1",
					error: null,
					id: "job-1",
					materialized: true,
					startedAtMs: Date.now() - 30_000,
					state: "building",
				}}
				profileStartedAt={Date.now() - 30_000}
			/>
		);

		expect(html).toContain("Run in background");
		expect(html).toContain("treated as untrusted data");
		expect(html).not.toContain("Continue setup");
	});
});

describe("onboarding provider setup", () => {
	test("offers OAuth sign-in for subscription providers that support it", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="providers"
				piProviders={[
					provider({
						authKind: "subscription",
						id: "openai-codex",
						label: "ChatGPT",
						supportsOAuth: true,
					}),
				]}
			/>
		);

		expect(html).toContain("Sign in");
		expect(html).not.toContain("ChatGPT API key");
	});

	test("keeps the API-key form for key-based providers", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="providers"
				piProviders={[provider({})]}
			/>
		);

		expect(html).toContain("API key");
		expect(html).toContain("Paste an API key");
	});

	test("does not ask for an API key when subscription OAuth is unavailable", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="providers"
				piProviders={[
					provider({
						authKind: "subscription",
						id: "subscription-provider",
						label: "Subscription Provider",
					}),
				]}
			/>
		);

		expect(html).toContain("Finish sign-in in provider settings");
		expect(html).not.toContain("Subscription Provider API key");
	});
});
