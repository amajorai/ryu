// apps/desktop/src/components/gateway/ApiSection.tsx
//
// The Gateway "API & traffic" surface. Three blocks, LM-Studio-style:
//
//  1. Endpoint URLs — copyable base URLs for OpenAI / Anthropic / Gemini
//     compatible clients to point at this node. Derived from the gateway's own
//     reported URL (Core's status proxy), so a remote node shows its real
//     address, not the loopback guess.
//  2. API keys — list the node's gateway keys (from `auth.api_keys`), issue a
//     new one locally (name + scoped limits), copy it once at creation (the
//     gateway never returns plaintext on GET), and revoke by name.
//  3. Live traffic — a dashboard fed by Core's `/api/gateway/traffic` SSE proxy:
//     live tiles (requests, tokens, error rate), a per-minute request-rate
//     sparkline, and a recent-requests table that streams new completions in.
//
// Auth + reachability mirror the rest of the dialog: `require_auth` and the
// key list come from `fetchGatewayConfig`; traffic from the SSE stream.

import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { GatewayClientKeys } from "./ApiSection-client-keys.tsx";
import { COPIED_RESET_MS } from "./ApiSection-constants.ts";
import { LiveTraffic } from "./ApiSection-live-traffic.tsx";

export { GatewayClientKeys } from "./ApiSection-client-keys.tsx";

/** A copy-to-clipboard row with a trailing label chip. */
function CopyRow({
	label,
	value,
	mono = true,
}: {
	label: string;
	mono?: boolean;
	value: string;
}) {
	const [copied, setCopied] = useState(false);
	const tl = useLiteralMessages();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			// Clipboard unavailable — nothing actionable to show.
		}
	};

	return (
		<SettingsItem
			actions={
				<Button
					aria-label={tl("Copy {label}", { label })}
					onClick={copy}
					size="sm"
					variant="ghost"
				>
					<MorphIconSwap
						a={Copy01Icon}
						b={Tick01Icon}
						className="size-4"
						state={copied ? "b" : "a"}
					/>
					{copied ? "Copied" : "Copy"}
				</Button>
			}
			title={label}
		>
			<span
				className={`block max-w-full truncate text-muted-foreground ${mono ? "font-mono text-xs" : ""}`}
			>
				{value}
			</span>
		</SettingsItem>
	);
}

// ── Endpoint URL cards ───────────────────────────────────────────────────────

function EndpointCard({ baseUrl }: { baseUrl: string }) {
	const openai = `${baseUrl}/v1/chat/completions`;
	const anthropic = `${baseUrl}/v1/messages`;
	const gemini = `${baseUrl}/v1beta/models`;
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Requests flow through the same budgets, filters and audit as desktop traffic."
					}
				>
					{"Point OpenAI, Anthropic or Gemini clients at this node."}
				</CaptionInfo>
			}
			title="Endpoint URLs"
		>
			<SettingsGroup>
				<CopyRow label="OpenAI compatible" value={openai} />
				<CopyRow label="Anthropic Messages" value={anthropic} />
				<CopyRow label="Google Gemini" value={gemini} />
			</SettingsGroup>
		</SettingsSection>
	);
}
// ── Section root ─────────────────────────────────────────────────────────────

export function ApiSection({
	canConfigure = true,
	canViewTraffic = true,
	managed,
	reachable,
	statusUrl,
	target,
}: {
	canConfigure?: boolean;
	/** Whether the caller holds `audit.view`, which Core requires for the feed. */
	canViewTraffic?: boolean;
	managed: boolean;
	reachable: boolean;
	statusUrl: string | null;
	target: ApiTarget;
}) {
	const baseUrl = statusUrl ?? target.url;
	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<EndpointCard baseUrl={baseUrl} />
			<GatewayClientKeys
				baseUrl={baseUrl}
				canConfigure={canConfigure}
				gatewayReady={reachable && statusUrl !== null}
				managed={managed}
				target={target}
			/>
			<LiveTraffic
				canView={canViewTraffic}
				reachable={reachable}
				target={target}
			/>
		</div>
	);
}
