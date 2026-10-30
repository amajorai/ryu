import {
	AgentByoaView,
	AgentIntegrationsView,
} from "@ryu/blocks/desktop/agent-edit.tsx";
import {
	type AgentIntegrationSnippetLang,
	buildAgentIntegrationSnippet,
	buildGitHubActionsSnippet,
} from "@ryu/blocks/desktop/agent-integration-snippets.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayApiKey,
	generateGatewayKey,
	registerByoaKey,
} from "@/src/lib/api/gateway.ts";

// ── BYOA panel ────────────────────────────────────────────────────────────────

interface ByoaPanelProps {
	agentId: string;
	target: ApiTarget;
}

function ByoaPanel({ target, agentId }: ByoaPanelProps) {
	const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
	const [existingKeys, setExistingKeys] = useState<GatewayApiKey[]>([]);
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<"url" | "key" | null>(null);

	const keyName = `byoa:${agentId}`;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const cfg = await fetchGatewayConfig(target);
			const keys = cfg.auth?.api_keys ?? [];
			setExistingKeys(keys);
		} catch {
			setError("Gateway config unavailable");
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		const coreBase = target.url.replace(PORT_SUFFIX_RE, "");
		setGatewayUrl(`${coreBase}:7981`);
	}, [target.url]);

	const existingKey = existingKeys.find((k) => k.name === keyName);
	const hasKey = Boolean(existingKey);

	const handleGenerate = async () => {
		setSaving(true);
		setError(null);
		const newKey = generateGatewayKey();
		try {
			const entry: GatewayApiKey = {
				name: keyName,
				key: newKey,
				trusted_forwarder: true,
			};
			await registerByoaKey(target, entry);
			setGeneratedKey(newKey);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to generate key");
		} finally {
			setSaving(false);
		}
	};

	const copyToClipboard = async (text: string, kind: "url" | "key") => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			setTimeout(() => setCopied(null), 2000);
		} catch {
			// Clipboard access may be blocked in some Tauri contexts — ignore.
		}
	};

	return (
		<AgentByoaView
			agentId={agentId}
			copied={copied}
			error={error}
			gatewayUrl={gatewayUrl}
			generatedKey={generatedKey}
			hasKey={hasKey}
			loading={loading}
			onCopyKey={() =>
				generatedKey ? copyToClipboard(generatedKey, "key") : undefined
			}
			onCopyUrl={() =>
				gatewayUrl ? copyToClipboard(`${gatewayUrl}/v1`, "url") : undefined
			}
			onGenerate={() => handleGenerate()}
			saving={saving}
		/>
	);
}

// ── Connect with code panel ─────────────────────────────────────────────────────

interface IntegrationsPanelProps {
	agentId: string;
	target: ApiTarget;
}

const TRAILING_SLASH_RE = /\/+$/;
const PORT_SUFFIX_RE = /:\d+$/;
const INTEGRATION_DOCS_PATH = "/docs/extend/develop/agent-integration-guide";

/** Strip the trailing slash so we never build `…//api/chat/stream`. */
function normalizeBase(url: string): string {
	return url.replace(TRAILING_SLASH_RE, "");
}

function openIntegrationDocs(): void {
	void openExternal(
		`${WEB_URL.replace(TRAILING_SLASH_RE, "")}${INTEGRATION_DOCS_PATH}`
	).catch(() => undefined);
}

export function IntegrationsPanel({ target, agentId }: IntegrationsPanelProps) {
	const [lang, setLang] = useState<AgentIntegrationSnippetLang>("typescript");
	const [copied, setCopied] = useState(false);

	const base = useMemo(() => normalizeBase(target.url), [target.url]);
	const hasToken = Boolean(target.token);
	const snippet = useMemo(
		() =>
			buildAgentIntegrationSnippet({
				agentId,
				baseUrl: base,
				hasToken,
				language: lang,
			}),
		[agentId, base, hasToken, lang]
	);
	const githubActionsSnippet = useMemo(
		() => buildGitHubActionsSnippet(agentId),
		[agentId]
	);

	const copySnippet = async () => {
		try {
			await navigator.clipboard.writeText(snippet);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard access may be blocked in some Tauri contexts.
		}
	};

	return (
		<AgentIntegrationsView
			agentId={agentId}
			byoaPanel={<ByoaPanel agentId={agentId} target={target} />}
			copied={copied}
			coreUrl={base}
			githubActionsSnippet={githubActionsSnippet}
			hasToken={hasToken}
			lang={lang}
			onCopy={() => {
				void copySnippet();
			}}
			onLangChange={setLang}
			onOpenDocs={openIntegrationDocs}
			snippet={snippet}
		/>
	);
}
