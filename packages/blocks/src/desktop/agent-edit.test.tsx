import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentSettingsForm,
	type AgentSettingsFormProps,
	triggerAccountLabel,
} from "./agent-edit.tsx";

function baseProps(
	overrides: Partial<AgentSettingsFormProps> = {}
): AgentSettingsFormProps {
	return {
		acpCommand: "",
		chatModel: "acp:ryu",
		composioActions: [],
		composioConfigured: false,
		composioToolkit: null,
		composioToolkitItems: [],
		composioTriggers: [],
		connectedAccountId: "",
		customCron: "",
		customTone: "",
		dailyTime: "09:00",
		engineOptions: [{ id: "acp:ryu", label: "Ryu" }],
		isBuiltIn: false,
		isLocked: false,
		isNew: false,
		memoryReadLevels: new Set(),
		memorySpaceIds: new Set(),
		memoryWriteEnabled: false,
		name: "Support desk",
		personaDisplayName: "",
		rules: [],
		schedulePhrase: "daily",
		selectedComposio: new Set(),
		selectedSkills: new Set(),
		selectedTools: new Set(),
		skills: [],
		spaces: [],
		systemPrompt: "Triage support requests and ask before making changes.",
		tone: "neutral",
		toneOptions: [{ label: "Neutral", value: "neutral" }],
		tools: [],
		triggerError: null,
		triggerSlug: "",
		triggerSubs: [],
		weeklyDay: "monday",
		weeklyTime: "09:00",
		healthBadge: <span>Health A</span>,
		healthPanel: <div>Health content</div>,
		initialTab: "health",
		...overrides,
	};
}

describe("AgentSettingsForm health integration", () => {
	test("renders the injected health panel as an editor tab", () => {
		const html = renderToStaticMarkup(<AgentSettingsForm {...baseProps()} />);

		expect(html).toContain("Health content");
		expect(html).toContain("Health A");
	});
});

describe("AgentSettingsForm tiers", () => {
	test("simple mode shows only the essentials and links to the Agent workspace", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					initialTab: "behavior",
					onOpenAdvanced: () => undefined,
					simple: true,
				})}
			/>
		);

		expect(html).toContain("Behavior");
		expect(html).toContain("Tools &amp; knowledge");
		expect(html).toContain("Triggers");
		expect(html).toContain("Advanced settings in the Agent workspace");
		expect(html).not.toContain("Connections");
		expect(html).not.toContain("Health content");
		expect(html).not.toContain("Search agent settings");
	});

	test("simple mode folds the model picker into Behavior", () => {
		const simpleHtml = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({ initialTab: "behavior", simple: true })}
			/>
		);
		const advancedHtml = renderToStaticMarkup(
			<AgentSettingsForm {...baseProps({ initialTab: "behavior" })} />
		);
		const modelTab = /role="tab"[^>]*>Model</;

		expect(simpleHtml).not.toMatch(modelTab);
		expect(simpleHtml).toContain("Model &amp; provider");
		expect(advancedHtml).toMatch(modelTab);
	});

	test("simple mode offers no Console link without access", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({ initialTab: "behavior", simple: true })}
			/>
		);

		expect(html).not.toContain("Advanced settings in the Agent workspace");
	});

	test("advanced mode keeps every tab after the essentials", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm {...baseProps({ initialTab: "behavior" })} />
		);

		expect(html.indexOf("Triggers")).toBeLessThan(html.indexOf("Connections"));
		expect(html).toContain("Health");
		expect(html).toContain("Search agent settings");
		expect(html).not.toContain("Advanced settings in the Agent workspace");
	});
});

describe("AgentSettingsForm identity and account access", () => {
	test("simple mode keeps the Identity section in Tools & knowledge", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					executionPolicyPanel: <div>Lifecycle panel</div>,
					identityModePanel: <div>Identity picker</div>,
					initialTab: "tools",
					simple: true,
				})}
			/>
		);

		expect(html).toContain(">Identity<");
		expect(html).toContain("Identity picker");
		expect(html).toContain('data-setting-id="agent.identity-mode"');
		expect(html.indexOf("Identity picker")).toBeLessThan(
			html.indexOf("Lifecycle panel")
		);
	});

	test("Connections renders Account access in place of the identity panel", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					accountAccessPanel: <div>Access list</div>,
					identityPanel: <div>Legacy identities</div>,
					initialTab: "connections",
				})}
			/>
		);

		expect(html).toContain("Account access");
		expect(html).toContain("Access list");
		expect(html).toContain('data-setting-id="agent.account-access"');
		expect(html).not.toContain("Legacy identities");
	});

	test("without an access panel the identity panel still renders", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					identityPanel: <div>Legacy identities</div>,
					initialTab: "connections",
				})}
			/>
		);

		expect(html).toContain("Legacy identities");
		expect(html).not.toContain("Account access");
	});

	test("the trigger account becomes a picker over the allowed accounts", () => {
		const props = baseProps({
			composioAccounts: [
				{ id: "ca_gmail", label: "gmail · Active", toolkit: "gmail" },
				{ id: "ca_slack", label: "slack · Active", toolkit: "slack" },
			],
			composioToolkit: "gmail",
			initialTab: "triggers",
			showComposioTriggers: true,
		});
		const html = renderToStaticMarkup(<AgentSettingsForm {...props} />);

		expect(html).toContain("Pick a connected account");
		expect(html).not.toContain("Paste the account id");

		const none = renderToStaticMarkup(
			<AgentSettingsForm {...props} composioAccounts={[]} />
		);
		expect(none).toContain("No connected gmail account this agent may");
		expect(none).not.toContain("Its own apps");
		// Acts as you: no accounts of its own to point to.
		expect(none).not.toContain("Agent&#x27;s own accounts");
		expect(none).toContain(
			"Connect one in Store → Connections or allow one under Connections → Account access."
		);
		expect(none).not.toContain("Paste the account id");

		const own = renderToStaticMarkup(
			<AgentSettingsForm
				{...props}
				composioAccounts={[]}
				ownAccountsAllowed={true}
			/>
		);
		expect(own).toContain(
			"connect one for the agent under Connections → Account access → Agent&#x27;s own accounts, or allow one under Connections → Account access."
		);
	});

	test("triggers the access on screen stops are marked paused", () => {
		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					composioToolkit: "gmail",
					initialTab: "triggers",
					showComposioTriggers: true,
					triggerSubs: [
						{
							id: "s1",
							paused: true,
							toolkit: "gmail",
							triggerSlug: "GMAIL_NEW",
						},
						{ id: "s2", toolkit: "gmail", triggerSlug: "GMAIL_SENT" },
					],
				})}
			/>
		);
		expect(html.match(/Paused: account not allowed</g)?.length).toBe(1);
	});

	test("simple mode shows Account access under Identity", () => {
		const props = baseProps({
			accountAccessPanel: <div>Access list</div>,
			composioAccounts: [],
			composioToolkit: "gmail",
			identityModePanel: <div>Identity picker</div>,
			initialTab: "tools",
			ownAccountsAllowed: true,
			simple: true,
		});
		const html = renderToStaticMarkup(<AgentSettingsForm {...props} />);

		expect(html).toContain("Access list");
		expect(html).toContain('data-setting-id="agent.account-access"');
		expect(html).not.toContain("Choose which accounts exactly under");
		expect(html.indexOf("Identity picker")).toBeLessThan(
			html.indexOf("Access list")
		);

		const triggers = renderToStaticMarkup(
			<AgentSettingsForm
				{...props}
				initialTab="triggers"
				showComposioTriggers={true}
			/>
		);
		expect(triggers).toContain(
			"under Tools &amp; knowledge → Identity → Agent&#x27;s own accounts, or allow one under Tools &amp; knowledge → Identity."
		);
	});

	test("trigger accounts and subscriptions name the agent's own accounts", () => {
		expect(
			triggerAccountLabel({
				id: "own_1",
				label: "gmail · Active",
				owner: "agent",
				toolkit: "gmail",
			})
		).toBe("This agent's account · gmail · Active");
		expect(
			triggerAccountLabel({
				id: "ca_1",
				label: "gmail · Active",
				owner: "you",
				toolkit: "gmail",
			})
		).toBe("Your account · gmail · Active");
		expect(
			triggerAccountLabel({ id: "ca_1", label: "gmail", toolkit: "gmail" })
		).toBe("gmail");

		const html = renderToStaticMarkup(
			<AgentSettingsForm
				{...baseProps({
					composioToolkit: "gmail",
					initialTab: "triggers",
					showComposioTriggers: true,
					triggerSubs: [
						{
							id: "s1",
							ownAccount: true,
							toolkit: "gmail",
							triggerSlug: "GMAIL_NEW",
						},
						{ id: "s2", toolkit: "gmail", triggerSlug: "GMAIL_SENT" },
					],
				})}
			/>
		);
		expect(html.match(/Its own account</g)?.length).toBe(1);
	});
});
