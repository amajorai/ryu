import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { ProviderLoginDialog } from "./dialogs/ProviderLoginDialog.tsx";
import { ProviderBrandMark } from "./LlmProvidersSettings-model-picker.tsx";
import type { ProviderCardState } from "./LlmProvidersSettings-provider-card-state.ts";
import { SpendLimitConfirm } from "./shared/provider-key-safety.tsx";

/** The OAuth sign-in block of a provider card. */
export function ProviderSubscriptionSection({
	state,
}: {
	state: ProviderCardState;
}) {
	const tl = useLiteralMessages();
	const {
		activeAccountId,
		handleLogin,
		handleLoginSuccess,
		hasOAuthAccount,
		isChatgptPlan,
		loginChoice,
		loginOpen,
		needsKey,
		oauthConnected,
		provider,
		setLoginChoice,
		setLoginOpen,
		setWelcomeOpen,
		welcomeOpen,
	} = state;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<span className="text-sm">
						{oauthConnected
							? "OAuth connected"
							: hasOAuthAccount
								? "OAuth account saved"
								: "OAuth not connected"}
					</span>
					<span className="text-detail text-muted-foreground">
						{needsKey
							? tl("Sign in with {label}, or use an API key below.", {
									label: provider.label,
								})
							: tl("Sign in with your {label} account. No API key needed.", {
									label: provider.label.replace(/\s*\([^)]*\)\s*$/, ""),
								})}
					</span>
				</div>
				<Button onClick={handleLogin} size="sm" variant="outline">
					{isChatgptPlan ? (
						<ProviderBrandMark label="ChatGPT" providerKey="chatgpt" />
					) : null}
					{isChatgptPlan
						? "Continue with ChatGPT"
						: hasOAuthAccount
							? "Add account"
							: "Login"}
				</Button>
			</div>
			{isChatgptPlan ? (
				<div className="flex flex-wrap items-center gap-2 text-detail text-muted-foreground">
					<span>
						{provider.connectionState === "identity-only"
							? "Identity is saved. Plan use needs separate permission."
							: "Eligible model requests use this ChatGPT plan. Add an account or reconnect the selected registration."}
					</span>
					<a
						className="underline underline-offset-4"
						href="https://chatgpt.com/settings/usage"
						rel="noopener noreferrer"
						target="_blank"
					>
						Manage usage
					</a>
					{activeAccountId ? (
						<Button
							onClick={() => {
								setLoginChoice({
									kind: "saved",
									accountId: activeAccountId,
									enablePlanUse: provider.connectionState === "identity-only",
								});
								setLoginOpen(true);
							}}
							size="sm"
							variant="outline"
						>
							{provider.connectionState === "identity-only"
								? "Enable plan use"
								: "Reconnect selected account"}
						</Button>
					) : null}
				</div>
			) : null}
			<ProviderLoginDialog
				accountId={
					loginChoice.kind === "saved" ? loginChoice.accountId : undefined
				}
				enablePlanUse={
					loginChoice.kind === "saved" && loginChoice.enablePlanUse
				}
				onOpenChange={setLoginOpen}
				onSuccess={handleLoginSuccess}
				open={loginOpen}
				providerId={provider.id}
				providerLabel={provider.label.replace(/\s*\([^)]*\)\s*$/, "")}
			/>
			<Dialog onOpenChange={setWelcomeOpen} open={welcomeOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Your ChatGPT plan is connected</DialogTitle>
						<DialogDescription>
							When you select this provider, eligible requests use your ChatGPT
							plan. You can review app limits and credit settings in ChatGPT.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							onClick={() =>
								window.open(
									"https://chatgpt.com/settings/usage",
									"_blank",
									"noopener,noreferrer"
								)
							}
							variant="outline"
						>
							Manage usage
						</Button>
						<Button onClick={() => setWelcomeOpen(false)}>Got it</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** The API key field, save/check/remove actions, and check result. */
export function ProviderApiKeySection({ state }: { state: ProviderCardState }) {
	const tl = useLiteralMessages();
	const {
		apiKey,
		checkResult,
		checking,
		handleCheck,
		handleRemove,
		handleSaveKey,
		limitConfirmed,
		provider,
		removing,
		savingKey,
		setApiKey,
		setLimitConfirmed,
	} = state;
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`key-${provider.id}`}>
				{provider.custom ? "API key (optional)" : "API key"}
			</Label>
			<div className="flex items-center gap-2">
				<Input
					autoComplete="off"
					className="flex-1"
					id={`key-${provider.id}`}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder={
						provider.custom
							? "Optional — leave blank to keep current setting"
							: provider.configured
								? "Stored — leave blank to keep"
								: "sk-…"
					}
					type="password"
					value={apiKey}
				/>
				<Button
					disabled={savingKey || apiKey.trim() === "" || !limitConfirmed}
					onClick={handleSaveKey}
					size="sm"
					variant="mono"
				>
					{savingKey ? "Saving…" : "Save"}
				</Button>
				{provider.supportsDiscovery === false ? null : (
					<Button
						disabled={checking}
						onClick={handleCheck}
						size="sm"
						variant="ghost"
					>
						{checking ? "Checking…" : "Check"}
					</Button>
				)}
				{provider.configured ? (
					<Button
						loading={removing}
						onClick={handleRemove}
						size="sm"
						variant="ghost"
					>
						{removing ? "Removing…" : "Remove"}
					</Button>
				) : null}
			</div>
			{apiKey.trim() === "" ? null : (
				<SpendLimitConfirm
					checked={limitConfirmed}
					id={`key-limit-${provider.id}`}
					onCheckedChange={setLimitConfirmed}
					providerId={provider.id}
					providerLabel={provider.label}
				/>
			)}
			{checking ? (
				<span className="flex items-center gap-1.5 text-detail text-muted-foreground">
					<Spinner className="size-3.5" /> Checking connectivity…
				</span>
			) : null}
			{!checking && checkResult ? (
				<span
					className={
						checkResult.ok
							? "text-detail text-status-success"
							: "text-detail text-status-destructive"
					}
				>
					{checkResult.ok
						? tl("OK · {latencyMs}ms · {modelCount} models", {
								latencyMs: String(checkResult.latencyMs),
								modelCount: String(checkResult.modelCount),
							})
						: (checkResult.error ?? "Check failed")}
				</span>
			) : null}
		</div>
	);
}
