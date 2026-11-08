import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentLaunchWarning } = await import("./AgentLaunchWarning.tsx");

// Core's launch refusal (`apps/core/src/i18n/messages/agent_launch.rs`) is
// English on the wire. Its templates and the generic engine labels are
// catalogued, so a German reader sees the whole sentence translated, with the
// engine label translated too and the provider's brand name kept.
const VENDOR_SOURCE =
	"{engineLabel} calls {provider} itself, using your own sign-in or key, and this agent's account access doesn't allow {provider}. Allow {provider} under Model providers in the agent's account access (an agent with only its own identity can't use your sign-ins, so choose Acts as you or Both first), or choose an engine that runs through Ryu's Gateway.";
const ROUTING_OFF_SOURCE =
	"{engineLabel} calls its model provider itself while its Gateway routing is off, so Ryu can't limit which of your providers it uses. Turn Gateway routing on for this agent, or remove the model provider limit from its account access.";

const SELF_CALLED_SOURCE =
	"{engineLabel} calls its model provider itself, so Ryu can't limit which of your providers it uses, and an agent with limited model providers can't run it. Choose an engine that runs through Ryu's Gateway, or remove the model provider limit from its account access.";

const JA: Record<string, string> = {
	[VENDOR_SOURCE]:
		"{engineLabel}は、あなた自身のサインインまたはキーを使って{provider}を直接呼び出しますが、このエージェントのアカウントアクセスでは{provider}が許可されていません。エージェントのアカウントアクセスのモデルプロバイダーで{provider}を許可するか、RyuのGatewayを経由するエンジンを選んでください。",
	"This custom agent": "このカスタムエージェント",
};

const AR: Record<string, string> = {
	[SELF_CALLED_SOURCE]:
		"{engineLabel} يستدعي مزوّد النماذج بنفسه، لذا لا يستطيع Ryu تقييد مزوّديك الذين يستخدمهم، ولا يمكن لوكيل بمزوّدين محدودين تشغيله. اختر محركًا يعمل عبر بوابة Ryu، أو أزل حد مزوّدي النماذج من وصول حسابه.",
	"This SDK app": "تطبيق SDK هذا",
};

const CATALOGS: Record<string, Record<string, string>> = {};

const DE: Record<string, string> = {
	[VENDOR_SOURCE]:
		"{engineLabel} ruft {provider} selbst auf, mit Ihrer eigenen Anmeldung oder Ihrem eigenen Schlüssel, und der Kontozugriff dieses Agenten erlaubt {provider} nicht. Erlauben Sie {provider} unter Modellanbieter im Kontozugriff des Agenten oder wählen Sie eine Engine, die über Ryus Gateway läuft.",
	[ROUTING_OFF_SOURCE]:
		"{engineLabel} ruft seinen Modellanbieter selbst auf, während sein Gateway-Routing aus ist, daher kann Ryu nicht einschränken, welche Ihrer Anbieter er nutzt. Schalten Sie das Gateway-Routing für diesen Agenten ein oder entfernen Sie die Begrenzung der Modellanbieter aus seinem Kontozugriff.",
	"This custom agent": "Dieser benutzerdefinierte Agent",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

CATALOGS.de = DE;
CATALOGS.ja = JA;
CATALOGS.ar = AR;

async function renderRefusal(reason: string, locale = "de"): Promise<string> {
	registerLiteralCatalogLoader((locale) => CATALOGS[locale.slice(0, 2)] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<AgentLaunchWarning
					check={{
						code: "provider_access_refused",
						launchable: false,
						limitedModelSource: null,
						modelWarning: null,
						reason,
						runsOnManagedPi: false,
						sandboxSupported: true,
						vendorProvider: null,
					}}
					engine="acp-exec:my-agent"
					modelsLimited
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	return (
		container.querySelector('[data-testid="agent-launch-warning"] span')
			?.textContent ?? ""
	);
}

test("a German reader sees the vendor refusal translated, label included", async () => {
	const text = await renderRefusal(
		"This custom agent calls OpenAI itself, using your own sign-in or key, and this agent's account access doesn't allow OpenAI. Allow OpenAI under Model providers in the agent's account access (an agent with only its own identity can't use your sign-ins, so choose Acts as you or Both first), or choose an engine that runs through Ryu's Gateway."
	);
	expect(text).toBe(
		"Dieser benutzerdefinierte Agent ruft OpenAI selbst auf, mit Ihrer eigenen Anmeldung oder Ihrem eigenen Schlüssel, und der Kontozugriff dieses Agenten erlaubt OpenAI nicht. Erlauben Sie OpenAI unter Modellanbieter im Kontozugriff des Agenten oder wählen Sie eine Engine, die über Ryus Gateway läuft."
	);
});

test("a registry engine's brand name stays as written", async () => {
	const text = await renderRefusal(
		"Claude Code calls its model provider itself while its Gateway routing is off, so Ryu can't limit which of your providers it uses. Turn Gateway routing on for this agent, or remove the model provider limit from its account access."
	);
	expect(text).toBe(
		"Claude Code ruft seinen Modellanbieter selbst auf, während sein Gateway-Routing aus ist, daher kann Ryu nicht einschränken, welche Ihrer Anbieter er nutzt. Schalten Sie das Gateway-Routing für diesen Agenten ein oder entfernen Sie die Begrenzung der Modellanbieter aus seinem Kontozugriff."
	);
});

test("a refusal with no catalog template keeps Core's English", async () => {
	const reason =
		"This computer has no sandbox for agents with limited accounts.";
	expect(await renderRefusal(reason)).toBe(reason);
});

test("a Japanese reader sees the vendor refusal translated, label included", async () => {
	const text = await renderRefusal(
		"This custom agent calls Anthropic itself, using your own sign-in or key, and this agent's account access doesn't allow Anthropic. Allow Anthropic under Model providers in the agent's account access (an agent with only its own identity can't use your sign-ins, so choose Acts as you or Both first), or choose an engine that runs through Ryu's Gateway.",
		"ja"
	);
	expect(text).toBe(
		"このカスタムエージェントは、あなた自身のサインインまたはキーを使ってAnthropicを直接呼び出しますが、このエージェントのアカウントアクセスではAnthropicが許可されていません。エージェントのアカウントアクセスのモデルプロバイダーでAnthropicを許可するか、RyuのGatewayを経由するエンジンを選んでください。"
	);
});

test("an Arabic reader sees the self-called refusal translated, SDK app label included", async () => {
	const text = await renderRefusal(
		"This SDK app calls its model provider itself, so Ryu can't limit which of your providers it uses, and an agent with limited model providers can't run it. Choose an engine that runs through Ryu's Gateway, or remove the model provider limit from its account access.",
		"ar"
	);
	expect(text).toContain("تطبيق SDK هذا");
	expect(text).toContain("يستدعي مزوّد النماذج بنفسه");
	expect(text).not.toContain("calls its model provider");
});
