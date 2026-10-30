"use client";
import { useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { type ReactNode, useState } from "react";
import { OnboardingActions, OnboardingCta } from "./onboarding-shell.tsx";
import type { OnboardingViewProps } from "./onboarding-types.ts";

// The runtime-choice fork (WS8). Local is the primary, always-available path
// (BYO keys / on-device); Ryu Cloud is gated on the plan entitlement. When not
// entitled, its button opens web pricing instead of provisioning anything.
// No key material is touched here, and choosing Cloud never provisions a server
// from the desktop.
export function ChooseStep({
	isDesktop,
	localChecking,
	localError,
	localUnreachable,
	managedEntitled,
	managedBusy,
	managedLoading,
	onChooseLocal,
	onChooseManaged,
	onChooseRemote,
	onDownloadDesktop,
}: Pick<
	OnboardingViewProps,
	| "isDesktop"
	| "localChecking"
	| "localError"
	| "localUnreachable"
	| "managedEntitled"
	| "managedBusy"
	| "managedLoading"
	| "onChooseLocal"
	| "onChooseManaged"
	| "onChooseRemote"
	| "onDownloadDesktop"
>) {
	let managedLabel = "Use Ryu Cloud";
	if (managedBusy) {
		managedLabel = "Connecting…";
	} else if (managedLoading) {
		managedLabel = "Checking your plan…";
	} else if (!managedEntitled) {
		managedLabel = "See team plans";
	}
	// One recommended choice carries the mono button: Ryu Cloud when the plan
	// includes it, otherwise this device. Every other choice is outline.
	const cloudRecommended = Boolean(managedEntitled);
	const localVariant = cloudRecommended ? "outline" : "mono";
	// On desktop the local pick installs and starts Core, so "Checking…" would
	// understate a download that can take a while; the webapp only probes.
	let localCta = "Set up locally";
	if (localChecking) {
		localCta = isDesktop ? "Setting up…" : "Checking…";
	}

	let localCard: ReactNode;
	if (localUnreachable && isDesktop) {
		localCard = (
			<ChoiceCard
				action={
					<Button
						className="w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						variant={localVariant}
					>
						{localChecking ? "Starting…" : "Try again"}
					</Button>
				}
				description="Try again, or choose another option."
				testId="onboarding-local-choice"
				title="Couldn't start local AI"
			>
				{/* The backend's own message stays reachable under the friendly line:
				    it is the only clue distinguishing a 404 on the release asset from
				    a full disk. */}
				{localError ? (
					<details className="mt-2 text-muted-foreground text-xs">
						<summary className="cursor-pointer">Details</summary>
						<p className="mt-1 break-all">{localError}</p>
					</details>
				) : null}
			</ChoiceCard>
		);
	} else if (localUnreachable) {
		localCard = (
			<ChoiceCard
				action={
					<div className="flex flex-col gap-2">
						<Button
							className="w-full"
							onClick={onDownloadDesktop}
							variant={localVariant}
						>
							Download the desktop app
						</Button>
						<Button
							className="w-full"
							disabled={localChecking}
							onClick={onChooseLocal}
							variant="ghost"
						>
							{localChecking ? "Checking…" : "Retry"}
						</Button>
					</div>
				}
				description="Install the Ryu desktop app to run AI here."
				testId="onboarding-local-choice"
				title="Desktop app needed"
			/>
		);
	} else {
		localCard = (
			<ChoiceCard
				action={
					<Button
						className="w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						variant={localVariant}
					>
						{localCta}
					</Button>
				}
				description="Private and offline. You manage downloads, updates, and performance."
				testId="onboarding-local-choice"
				title="Set it up yourself"
			/>
		);
	}

	return (
		<div className="grid w-full grid-cols-1 gap-3 md:grid-cols-3">
			<ChoiceCard
				action={
					<Button
						className="w-full"
						disabled={managedBusy || managedLoading}
						onClick={onChooseManaged}
						variant={cloudRecommended ? "mono" : "outline"}
					>
						{managedLabel}
					</Button>
				}
				description="Ryu handles downloads, updates, and the server. Start working right away."
				testId="onboarding-cloud-choice"
				title="Let Ryu handle it"
			/>

			{localCard}

			<ChoiceCard
				action={
					<Button className="w-full" onClick={onChooseRemote} variant="outline">
						Connect a server
					</Button>
				}
				description="Connect to a server your team runs. Your team handles updates and access."
				testId="onboarding-existing-node-choice"
				title="Bring your own server"
			/>
		</div>
	);
}

/** One choice in the fork: a title, one description and its action at the
 *  bottom, so the three cards line up however long their copy runs. */
function ChoiceCard({
	action,
	children,
	description,
	testId,
	title,
}: {
	action: ReactNode;
	children?: ReactNode;
	description: string;
	testId: string;
	title: string;
}) {
	const localizedTitle = useLocalizedText(title, { literal: true });
	return (
		<div
			className="flex flex-col rounded-xl border border-border p-4 text-left"
			data-testid={testId}
		>
			<h2 className="font-semibold text-sm">{localizedTitle}</h2>
			<p className="mt-1 text-pretty text-detail text-muted-foreground">
				{description}
			</p>
			{children}
			<div className="mt-auto pt-4">{action}</div>
		</div>
	);
}

// The `connect` step: address + optional token for a Core the user already runs.
// The container owns the probe; this only collects and reports. The URL is the
// only required field — a node with auth off accepts an empty token, and a wrong
// one surfaces as `remoteError` rather than being guessed at here.
export function ConnectStep({
	onBackFromConnect,
	onConnectRemote,
	remoteChecking,
	remoteError,
}: Pick<
	OnboardingViewProps,
	"onBackFromConnect" | "onConnectRemote" | "remoteChecking" | "remoteError"
>) {
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const trimmedUrl = url.trim();
	const submit = () => {
		if (remoteChecking || trimmedUrl === "") {
			return;
		}
		onConnectRemote?.(trimmedUrl, token.trim());
	};

	return (
		<form
			className="flex w-full flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			{/* Both fields carry their name in the placeholder, the way the sign-in
				    form does — the labels stay in the tree but visually hidden, because a
				    placeholder is not an accessible name and vanishes as soon as the user
				    types. The example address and the "optional" qualifier move into the
				    hint below each field, which is where they still read once the
				    placeholder is gone. */}
			<div className="flex flex-col gap-2">
				<Label className="sr-only" htmlFor="onboarding-node-url">
					Node address
				</Label>
				<Input
					autoComplete="off"
					autoFocus
					id="onboarding-node-url"
					onChange={(e) => setUrl(e.target.value)}
					placeholder="Node address"
					spellCheck={false}
					value={url}
				/>
				<p className="text-detail text-muted-foreground">
					The address of the machine running Ryu Core, including the port — for
					example http://192.168.1.20:7980.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Label className="sr-only" htmlFor="onboarding-node-token">
					Access token
				</Label>
				<Input
					autoComplete="off"
					id="onboarding-node-token"
					onChange={(e) => setToken(e.target.value)}
					placeholder="Access token"
					spellCheck={false}
					type="password"
					value={token}
				/>
				<p className="text-detail text-muted-foreground">
					Optional — leave empty if the node has no token. Whoever runs the node
					can read it from their Ryu settings.
				</p>
			</div>

			{remoteError ? (
				<p className="text-sm text-status-destructive">{remoteError}</p>
			) : null}

			<OnboardingActions>
				<OnboardingCta
					disabled={remoteChecking}
					onClick={onBackFromConnect}
					tone="secondary"
					type="button"
				>
					Back
				</OnboardingCta>
				<OnboardingCta
					disabled={remoteChecking || trimmedUrl === ""}
					type="submit"
				>
					{remoteChecking ? "Connecting…" : "Connect"}
				</OnboardingCta>
			</OnboardingActions>
		</form>
	);
}
