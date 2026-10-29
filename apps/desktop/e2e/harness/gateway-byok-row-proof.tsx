import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderRow } from "../../src/components/gateway/ProviderKeyRow.tsx";
import type { ByokProvider } from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const providers: Array<{
	label: string;
	placeholder: string;
	slug: ByokProvider;
}> = [
	{ slug: "openai", label: "OpenAI", placeholder: "sk-…" },
	{ slug: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
	{ slug: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
	{ slug: "gemini", label: "Gemini", placeholder: "AIza…" },
];
const search = new URL(window.location.href).searchParams;
const initialKeys: Partial<Record<ByokProvider, string>> =
	search.get("isSet") === "true"
		? Object.fromEntries(providers.map(({ slug }) => [slug, "stored-key"]))
		: {};
interface ByokRowCapturedState {
	clearCalls: Parameters<Parameters<typeof ProviderRow>[0]["onClear"]>[0][];
	failClear: boolean;
	failSave: boolean;
	saveCalls: Array<{
		key: Parameters<Parameters<typeof ProviderRow>[0]["onSave"]>[1];
		slug: Parameters<Parameters<typeof ProviderRow>[0]["onSave"]>[0];
	}>;
}

const state: ByokRowCapturedState = {
	clearCalls: [],
	failClear: search.get("failClear") === "true",
	failSave: search.get("failSave") === "true",
	saveCalls: [],
};

declare global {
	interface Window {
		__gatewayByokProof: typeof state;
	}
}

window.__gatewayByokProof = state;

function ProofSurface() {
	const [keys, setKeys] = useState(initialKeys);
	const [status, setStatus] = useState("");
	const managed = search.get("managed") === "true";
	const canConfigure = search.get("canConfigure") !== "false";

	return (
		<main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
			<h1 className="font-semibold text-2xl">Provider keys (BYOK)</h1>
			<div aria-live="polite" role="status">
				{status}
			</div>
			{providers.map(({ slug, label, placeholder }) => (
				<div data-testid={slug} key={slug}>
					<ProviderRow
						canConfigure={canConfigure}
						isSet={Boolean(keys[slug])}
						label={label}
						onClear={async (provider) => {
							state.clearCalls.push(provider);
							if (state.failClear) {
								throw new Error("Credential store refused deletion");
							}
							setKeys((current) => {
								const next = { ...current };
								delete next[provider];
								return next;
							});
							setStatus(`${label} key cleared`);
						}}
						onSave={async (provider, key) => {
							state.saveCalls.push({ key, slug: provider });
							if (state.failSave) {
								throw new Error("Credential store unavailable");
							}
							setKeys((current) => ({ ...current, [provider]: key }));
							setStatus(`${label} key saved`);
						}}
						placeholder={placeholder}
						readOnly={managed}
						slug={slug}
					/>
				</div>
			))}
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<ProofSurface />);
