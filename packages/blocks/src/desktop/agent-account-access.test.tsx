import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentAccountAccessView,
	type AgentAccountAccessViewProps,
	AgentOwnConnectedAppsCard,
} from "./agent-account-access.tsx";
import {
	AGENT_IDENTITY_MODE_OPTIONS,
	AgentIdentityModePicker,
	AgentRemotePeerIdentityNote,
	isAgentIdentityMode,
	isRemotePeerEngine,
	modeHasOwnAccounts,
	modeUsesYourAccounts,
} from "./agent-identity-mode.tsx";

const ignore = () => undefined;

function viewProps(
	overrides: Partial<AgentAccountAccessViewProps> = {}
): AgentAccountAccessViewProps {
	return {
		accountAccess: null,
		connectedApps: {
			configured: true,
			loading: false,
			rows: [{ key: "composio:ca_gmail", title: "gmail" }],
		},
		disabled: false,
		identities: {
			loading: false,
			onToggle: ignore,
			profileIds: [],
			selected: new Set(),
		},
		identityMode: "managed",
		mcpSignIns: null,
		modelProviders: {
			error: false,
			loading: false,
			rows: [{ key: "provider:openai", title: "OpenAI" }],
		},
		onLimitChange: ignore,
		onToggle: ignore,
		ownConnectedApps: (
			<AgentOwnConnectedAppsCard>
				<p>own apps body</p>
			</AgentOwnConnectedAppsCard>
		),
		ownLogins: {
			error: false,
			loading: false,
			rows: [{ key: "agent:login-1", title: "status.example.com" }],
			unsaved: false,
		},
		savedKeys: { error: false, loading: false, rows: [] },
		...overrides,
	};
}

/** The checkbox of the account row titled `title`: its checked and disabled state. */
function checkboxFor(
	html: string,
	title: string
): { checked: string | null; disabled: boolean } | null {
	const titleAt = html.indexOf(`>${title}<`);
	const boxAt = html.lastIndexOf('role="checkbox"', titleAt);
	if (titleAt < 0 || boxAt < 0) {
		return null;
	}
	const tagStart = html.lastIndexOf("<", boxAt);
	const tag = html.slice(tagStart, html.indexOf(">", boxAt) + 1);
	return {
		checked: /aria-checked="(true|false)"/.exec(tag)?.[1] ?? null,
		disabled: tag.includes('aria-disabled="true"'),
	};
}

describe("AgentIdentityModePicker", () => {
	test("renders the three modes with the icon above each title", () => {
		const html = renderToStaticMarkup(
			<AgentIdentityModePicker onChange={ignore} size="hero" value="mixed" />
		);
		for (const mode of ["managed", "individual", "mixed"] as const) {
			const card = html.indexOf(`data-identity-mode="${mode}"`);
			expect(card).toBeGreaterThan(-1);
			const title = html.indexOf(AGENT_IDENTITY_MODE_OPTIONS[mode].title, card);
			const icon = html.indexOf("<svg", card);
			expect(icon).toBeGreaterThan(card);
			expect(icon).toBeLessThan(title);
		}
		expect(html).toContain('aria-label="How should this agent work?"');
	});

	test("mode helpers follow whose accounts each mode may use", () => {
		expect(isAgentIdentityMode("individual")).toBe(true);
		expect(isAgentIdentityMode("owner")).toBe(false);
		expect(modeUsesYourAccounts("individual")).toBe(false);
		expect(modeUsesYourAccounts("mixed")).toBe(true);
		expect(modeHasOwnAccounts("managed")).toBe(false);
		expect(modeHasOwnAccounts("mixed")).toBe(true);
	});
});

describe("AgentAccountAccessView", () => {
	test("acts as you, unrestricted: your accounts show ticked and locked", () => {
		const html = renderToStaticMarkup(
			<AgentAccountAccessView {...viewProps()} />
		);
		expect(html).toContain("Your accounts");
		expect(html).toContain("gmail");
		expect(html).toContain("OpenAI");
		expect(html).toContain("Control of your desktop");
		expect(html).toContain(
			"Unrestricted: the agent may use every account below."
		);
		expect(html).toContain(
			"This agent acts as you, so it has no accounts of its own."
		);
		expect(html).not.toContain("own apps body");
		expect(checkboxFor(html, "gmail")).toEqual({
			checked: "true",
			disabled: true,
		});
	});

	test("its own identity, limited: only its own ticked accounts are offered", () => {
		const html = renderToStaticMarkup(
			<AgentAccountAccessView
				{...viewProps({
					accountAccess: ["agent:login-1"],
					identityMode: "individual",
				})}
			/>
		);
		expect(html).toContain(
			"This agent has its own identity, so it never uses your accounts."
		);
		expect(html).not.toContain("gmail");
		expect(html).not.toContain("Control of your desktop");
		expect(html).toContain("status.example.com");
		expect(html).toContain("own apps body");
		expect(html).toContain("Only the accounts ticked below can be used.");
		expect(checkboxFor(html, "status.example.com")).toEqual({
			checked: "true",
			disabled: false,
		});
	});

	test("shows Core's launch refusal and the no-sandbox line when given", () => {
		const html = renderToStaticMarkup(
			<AgentAccountAccessView
				{...viewProps({
					engineRefusal: "This engine can't start for this agent.",
					noSandboxNote: "No sandbox on this computer.",
				})}
			/>
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("This engine can&#x27;t start for this agent.");
		expect(html).toContain("No sandbox on this computer.");
	});

	test("a brand-new agent is asked to save before it has logins of its own", () => {
		const html = renderToStaticMarkup(
			<AgentAccountAccessView
				{...viewProps({
					identityMode: "mixed",
					ownLogins: { error: false, loading: false, rows: [], unsaved: true },
				})}
			/>
		);
		expect(html).toContain(
			"Save the agent first. It can then sign up for accounts of its own."
		);
		expect(html).toContain("Your accounts");
	});
});

describe("remote A2A peer identity", () => {
	test("only an a2a: engine is a remote peer", () => {
		expect(isRemotePeerEngine("a2a:peer-hermes")).toBe(true);
		expect(isRemotePeerEngine("  a2a:peer-hermes ")).toBe(true);
		for (const engine of ["acp:pi", "acp-exec:a2a:peer", "", null, undefined]) {
			expect(isRemotePeerEngine(engine)).toBe(false);
		}
	});

	test("the note replaces the choice instead of offering it", () => {
		const html = renderToStaticMarkup(<AgentRemotePeerIdentityNote />);
		expect(html).toContain("Runs on another node");
		expect(html).toContain(
			"Only an agent that acts as you with no account limit can hand work to it."
		);
		expect(html).not.toContain('role="radio"');
		for (const option of Object.values(AGENT_IDENTITY_MODE_OPTIONS)) {
			expect(html).not.toContain(option.title);
		}
	});
});
