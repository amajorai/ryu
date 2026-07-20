import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchIngressBackend, setIngressBackend } from "@/src/lib/api/mesh.ts";
import {
	type AaStatsMode,
	getAaApiKey,
	getAaStatsMode,
	getHfToken,
	getPreference,
	setAaApiKey,
	setAaStatsMode,
	setHfToken,
	setPreference,
} from "@/src/lib/api/preferences.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Friendly labels for the ingress backend kinds Core emits (snake_case). Falls
// back to a title-cased form for any kind not listed here, so a new backend
// added in Core still renders sensibly without a desktop change.
const INGRESS_LABELS: Record<string, string> = {
	ryu_relay: "Ryu Relay (managed)",
	tailscale_funnel: "Tailscale Funnel",
	cloudflared: "Cloudflare Tunnel",
	own_relay: "Self-hosted relay",
};

function ingressLabel(kind: string): string {
	if (INGRESS_LABELS[kind]) {
		return INGRESS_LABELS[kind];
	}
	return kind
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function IntegrationsTab() {
	const [hfToken, setHfTokenValue] = useState("");
	const [aaKey, setAaKeyValue] = useState("");
	const [aaMode, setAaModeValue] = useState<AaStatsMode>("cached");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savingAa, setSavingAa] = useState(false);
	// Webhook ingress: the public-URL backend that receives Composio trigger
	// events. `null` = the running Core has no ingress plane (older binary), so
	// the section is hidden entirely.
	const [ingressBackend, setIngressBackendValue] = useState("");
	const [ingressChoices, setIngressChoices] = useState<string[] | null>(null);
	const [ingressDefault, setIngressDefault] = useState("");
	const [savingIngress, setSavingIngress] = useState(false);
	// Headscale: self-hosted Tailscale control server URL.
	const [headscaleUrl, setHeadscaleUrlValue] = useState("");
	const [headscaleLoaded, setHeadscaleLoaded] = useState(false);
	const [savingHeadscale, setSavingHeadscale] = useState(false);

	const navigate = useNavigate();
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const closeSettings = useSettingsDialog((s) => s.setOpen);
	// This tab now lives in the Gateway dialog, but may still be reachable from
	// Settings; close whichever large modal is hosting it before leaving to a page.
	const closeGateway = useGatewayDialog((s) => s.setOpen);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		Promise.all([
			getHfToken(target),
			getAaApiKey(target),
			getAaStatsMode(target),
		]).then(([token, key, mode]) => {
			if (!cancelled) {
				setHfTokenValue(token);
				setAaKeyValue(key);
				setAaModeValue(mode);
				setLoaded(true);
			}
		});
		// Ingress backend is a soft dependency — an older Core 404s here, which
		// we swallow and leave `ingressChoices` null so the section stays hidden.
		fetchIngressBackend(target)
			.then((cfg) => {
				if (!cancelled) {
					setIngressBackendValue(cfg.backend);
					setIngressChoices(cfg.available);
					setIngressDefault(cfg.default);
				}
			})
			.catch(() => {
				// No ingress plane on this node — leave the section hidden.
			});
		getPreference(target, "mesh-login-server").then((val) => {
			if (!cancelled) {
				setHeadscaleUrlValue(val ?? "");
				setHeadscaleLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleSelectIngress = async (kind: string | null) => {
		if (!kind || kind === ingressBackend) {
			return;
		}
		const previous = ingressBackend;
		setIngressBackendValue(kind);
		setSavingIngress(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		try {
			await setIngressBackend(target, kind);
			sileo.success({
				title: `Ingress set to ${ingressLabel(kind)}`,
				description: "Restart this node for the change to take effect.",
			});
		} catch (e) {
			setIngressBackendValue(previous);
			sileo.error({
				title: "Failed to set ingress backend",
				description: e instanceof Error ? e.message : undefined,
			});
		} finally {
			setSavingIngress(false);
		}
	};

	const handleToggleRealtime = async (live: boolean) => {
		const next: AaStatsMode = live ? "realtime" : "cached";
		setAaModeValue(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setAaStatsMode(target, next);
		if (ok) {
			sileo.success({
				title: live
					? "Using live Artificial Analysis data"
					: "Using cached data",
			});
		} else {
			setAaModeValue(live ? "cached" : "realtime");
			sileo.error({ title: "Failed to update data mode" });
		}
	};

	const handleSave = async () => {
		setSaving(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setHfToken(target, hfToken);
		setSaving(false);
		if (ok) {
			sileo.success({ title: "Hugging Face token saved" });
		} else {
			sileo.error({ title: "Failed to save Hugging Face token" });
		}
	};

	const handleSaveAa = async () => {
		setSavingAa(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setAaApiKey(target, aaKey);
		setSavingAa(false);
		if (ok) {
			sileo.success({ title: "Artificial Analysis key saved" });
		} else {
			sileo.error({ title: "Failed to save Artificial Analysis key" });
		}
	};

	const handleSaveHeadscale = async () => {
		setSavingHeadscale(true);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setPreference(target, "mesh-login-server", headscaleUrl);
		setSavingHeadscale(false);
		if (ok) {
			sileo.success({
				title: "Headscale server saved",
				description:
					"Restart the mesh daemon (or this node) for the change to take effect.",
			});
		} else {
			sileo.error({ title: "Failed to save Headscale server URL" });
		}
	};

	// Close this dialog before opening the Gateway dialog — both are large
	// modals, so stacking them would trap focus in two places at once.
	const handleOpenGatewayKeys = () => {
		closeSettings(false);
		openGateway("keys");
	};

	const handleOpenMarketplace = () => {
		closeSettings(false);
		closeGateway(false);
		navigate("/marketplace");
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Add a Hugging Face access token to raise download rate limits and install gated models — the ones marked with a lock in the model catalog."
				title="Hugging Face"
			>
				<SettingsGroup>
					<SettingsItem title="Access token">
						<div className="flex items-center gap-2">
							<Input
								autoComplete="off"
								className="h-8 flex-1 text-xs"
								disabled={!loaded}
								id="hf-token"
								onChange={(e) => setHfTokenValue(e.target.value)}
								placeholder="hf_…"
								type="password"
								value={hfToken}
							/>
							<Button
								disabled={!loaded || saving}
								onClick={handleSave}
								size="sm"
							>
								{saving ? "Saving…" : "Save"}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Stored locally on this device and sent only to huggingface.co.
							Leave empty and save to remove it.
						</p>
					</SettingsItem>
				</SettingsGroup>

				<div className="mx-3 space-y-1.5 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
					<p className="font-medium text-foreground">How to set this up</p>
					<ol className="list-decimal space-y-1 pl-4">
						<li>
							Create a token at{" "}
							<a
								className="underline hover:text-foreground"
								href="https://huggingface.co/settings/tokens"
								rel="noopener noreferrer"
								target="_blank"
							>
								huggingface.co/settings/tokens
							</a>{" "}
							— a <code>read</code> token is enough.
						</li>
						<li>Paste it above and click Save.</li>
						<li>
							For each gated model, open its Hugging Face page and accept the
							model's terms first. A token alone does not unlock a gated
							download.
						</li>
					</ol>
				</div>
			</SettingsSection>

			<SettingsSection
				caption="Add an Artificial Analysis API key to enrich the model catalog with independent benchmark stats — intelligence index, output speed, latency, and price. The catalog works fine without one."
				title="Artificial Analysis"
			>
				<SettingsGroup>
					<SettingsItem title="API key">
						<div className="flex items-center gap-2">
							<Input
								autoComplete="off"
								className="h-8 flex-1 text-xs"
								disabled={!loaded}
								id="aa-key"
								onChange={(e) => setAaKeyValue(e.target.value)}
								placeholder="aa-…"
								type="password"
								value={aaKey}
							/>
							<Button
								disabled={!loaded || savingAa}
								onClick={handleSaveAa}
								size="sm"
							>
								{savingAa ? "Saving…" : "Save"}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Stored locally on this device and sent only to
							artificialanalysis.ai. Leave empty and save to remove it.
						</p>
					</SettingsItem>
					<SettingsItem
						actions={
							<Switch
								checked={aaMode === "realtime"}
								disabled={!loaded}
								id="aa-realtime"
								onCheckedChange={handleToggleRealtime}
							/>
						}
						description="Off (default): cache the stats on this device and refresh once a day — kinder to the API's daily rate limit. On: fetch live every time."
						title="Live data"
					/>
				</SettingsGroup>

				<div className="mx-3 space-y-1.5 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
					<p className="font-medium text-foreground">How to set this up</p>
					<ol className="list-decimal space-y-1 pl-4">
						<li>
							Create a free key at{" "}
							<a
								className="underline hover:text-foreground"
								href="https://artificialanalysis.ai/api-reference"
								rel="noopener noreferrer"
								target="_blank"
							>
								artificialanalysis.ai/api-reference
							</a>
							.
						</li>
						<li>Paste it above and click Save.</li>
						<li>
							Stats appear on model detail pages in the catalog when a model
							matches an Artificial Analysis entry.
						</li>
					</ol>
				</div>
			</SettingsSection>

			<SettingsSection
				caption="Composio powers agent connections (Gmail, GitHub, Slack, and 800+ apps). Its API key now lives with the other execution credentials in Gateway → Keys; browse and connect accounts in Marketplace → Connections."
				title="Composio"
			>
				<div className="mx-3 space-y-1.5 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
					<p className="font-medium text-foreground">Moved to Gateway → Keys</p>
					<ol className="list-decimal space-y-1 pl-4">
						<li>
							Open Gateway settings → Keys and paste your Composio API key
							(create one at{" "}
							<a
								className="underline hover:text-foreground"
								href="https://platform.composio.dev"
								rel="noopener noreferrer"
								target="_blank"
							>
								platform.composio.dev
							</a>
							).
						</li>
						<li>
							Go to Marketplace → Connections to connect the apps you want
							(Gmail, GitHub, …).
						</li>
						<li>
							Open an agent in the editor → Connections to attach connected
							toolkits, choosing all tools or specific ones.
						</li>
					</ol>
					<div className="flex flex-wrap gap-2 pt-1">
						<Button onClick={handleOpenGatewayKeys} size="sm" variant="outline">
							Open Gateway keys
						</Button>
						<Button onClick={handleOpenMarketplace} size="sm" variant="outline">
							Open Marketplace
						</Button>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				caption="Point the mesh at a self-hosted Headscale server instead of Tailscale SaaS. Leave empty to use Tailscale SaaS. Applies when the mesh daemon next enrolls (new node or re-enrollment)."
				title="Headscale"
			>
				<SettingsGroup>
					<SettingsItem title="Control server URL">
						<div className="flex items-center gap-2">
							<Input
								autoComplete="off"
								className="h-8 flex-1 text-xs"
								disabled={!headscaleLoaded}
								id="headscale-url"
								onChange={(e) => setHeadscaleUrlValue(e.target.value)}
								placeholder="https://headscale.example.com"
								type="url"
								value={headscaleUrl}
							/>
							<Button
								disabled={!headscaleLoaded || savingHeadscale}
								onClick={handleSaveHeadscale}
								size="sm"
							>
								{savingHeadscale ? "Saving…" : "Save"}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Passed as <code>--login-server</code> to <code>tailscale up</code>
							. Leave empty and save to revert to Tailscale SaaS.
						</p>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			{ingressChoices && ingressChoices.length > 0 && (
				<SettingsSection
					caption="Choose how this node exposes a public URL to receive inbound webhooks (the Composio triggers above need one). The backend is built when the node starts, so a change applies after a restart."
					title="Webhook ingress"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={savingIngress}
									items={ingressChoices.map((kind) => ({
										label: ingressLabel(kind),
										value: kind,
									}))}
									onValueChange={handleSelectIngress}
									value={ingressBackend}
								>
									<SelectTrigger className="h-8 w-56 text-xs">
										<SelectValue placeholder="Select a backend" />
									</SelectTrigger>
									<SelectContent>
										{ingressChoices.map((kind) => (
											<SelectItem key={kind} value={kind}>
												{ingressLabel(kind)}
												{kind === ingressDefault ? " (default)" : ""}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description="Applies on the next node restart. Ryu Relay is the managed default; Tailscale Funnel and Cloudflare Tunnel expose this node's own URL."
							title="Ingress backend"
						/>
					</SettingsGroup>
				</SettingsSection>
			)}
		</div>
	);
}
