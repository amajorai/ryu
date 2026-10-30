import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useCallback, useState } from "react";
import { ProviderLoginDialog } from "@/src/components/settings/dialogs/ProviderLoginDialog.tsx";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import { ContinueRow } from "./OnboardingSetupStep.parts.tsx";

export function ProviderLogo({ provider }: { provider: PiProvider }) {
	const hasBrand = Boolean(svglForProvider(`${provider.id} ${provider.label}`));
	return (
		<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
			{hasBrand ? (
				<ProviderBrandLogo
					providerKey={`${provider.id} ${provider.label}`}
					size={20}
				/>
			) : (
				<span className="font-medium text-sm">
					{provider.label.slice(0, 1).toUpperCase()}
				</span>
			)}
		</div>
	);
}

export function ProviderSetup({
	providers,
	defaultProviderIds,
	freeCloud,
	busyId,
	onConfigure,
	onProviderConnected,
	onContinue,
}: {
	busyId: string | null;
	defaultProviderIds: readonly string[];
	freeCloud: boolean;
	onConfigure: (providerId: string, apiKey: string) => void;
	onProviderConnected: () => void;
	onContinue: () => void;
	providers: PiProvider[];
}) {
	const tl = useLiteralMessages();
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [connectedProviderIds, setConnectedProviderIds] = useState<string[]>(
		[]
	);
	const [loginProvider, setLoginProvider] = useState<PiProvider | null>(null);
	const visible = providers.filter(
		(provider) =>
			provider.id !== "local" &&
			provider.id !== "gateway" &&
			(!freeCloud || provider.id !== "managed-openrouter")
	);
	const configuredCount = visible.filter(
		(provider) =>
			provider.configured ||
			defaultProviderIds.includes(provider.id) ||
			connectedProviderIds.includes(provider.id)
	).length;
	const handleProviderLoginSuccess = useCallback(() => {
		if (!loginProvider) {
			return;
		}
		setConnectedProviderIds((current) =>
			current.includes(loginProvider.id)
				? current
				: [...current, loginProvider.id]
		);
		onProviderConnected();
	}, [loginProvider, onProviderConnected]);
	return (
		<div className="flex flex-col gap-3">
			<div
				className="text-pretty text-detail text-muted-foreground"
				data-testid="onboarding-provider-check"
			>
				{configuredCount > 0
					? [
							"Provider connections already set up — ",
							configuredCount,
							" configured provider",
							configuredCount === 1 ? "" : "s",
							" found on this node.",
						].join("")
					: "Provider connections are optional. Sign in to a subscription provider or add an API key for cloud chats; local chats keep working if you skip this step."}
			</div>
			{visible.map((provider) => {
				const key = keys[provider.id] ?? "";
				const configured =
					provider.configured ||
					defaultProviderIds.includes(provider.id) ||
					connectedProviderIds.includes(provider.id);
				const supportsOAuth =
					provider.authKind === "subscription" &&
					provider.supportsOAuth === true;
				const oauthUnavailable =
					provider.authKind === "subscription" && !supportsOAuth;
				return (
					<div className="flex flex-col gap-3" key={provider.id}>
						<div className="flex items-center gap-3">
							<ProviderLogo provider={provider} />
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">{provider.label}</p>
								<p className="text-detail text-muted-foreground">
									{configured
										? "Configured on this node"
										: supportsOAuth
											? "Sign in to use this provider"
											: oauthUnavailable
												? "Finish sign-in in provider settings"
												: "API key"}
								</p>
							</div>
							{configured ? (
								<span className="text-status-success text-xs">Ready</span>
							) : null}
						</div>
						{configured ? null : supportsOAuth ? (
							<div className="flex justify-end">
								<Button
									disabled={loginProvider !== null || busyId === provider.id}
									loading={loginProvider?.id === provider.id}
									onClick={() => setLoginProvider(provider)}
									size="sm"
									variant="outline"
								>
									Sign in
								</Button>
							</div>
						) : oauthUnavailable ? (
							<p className="text-right text-muted-foreground text-xs">
								Add this provider from Settings → Providers.
							</p>
						) : (
							<div className="flex gap-2">
								<Input
									aria-label={tl("{label} API key", { label: provider.label })}
									onChange={(event) =>
										setKeys((current) => ({
											...current,
											[provider.id]: event.target.value,
										}))
									}
									placeholder="Paste an API key"
									type="password"
									value={key}
								/>
								<Button
									disabled={!key.trim() || busyId === provider.id}
									loading={busyId === provider.id}
									onClick={() => onConfigure(provider.id, key.trim())}
									size="sm"
									variant="outline"
								>
									Connect
								</Button>
							</div>
						)}
					</div>
				);
			})}
			{loginProvider ? (
				<ProviderLoginDialog
					onOpenChange={(open) => {
						if (!open) {
							setLoginProvider(null);
						}
					}}
					onSuccess={handleProviderLoginSuccess}
					open
					providerId={loginProvider.id}
					providerLabel={loginProvider.label}
				/>
			) : null}
			<ContinueRow onContinue={onContinue} />
		</div>
	);
}
