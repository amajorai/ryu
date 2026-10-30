import {
	Alert02Icon,
	Cancel01Icon,
	CloudServerIcon,
	DollarCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import { sileo } from "sileo";
import { cn } from "@/lib/utils.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { creditBalanceStatus } from "@/src/lib/credit-warning.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import layoutStyles from "./NodeSelector.module.css";
import {
	displayName,
	type LayoutCssVariables,
} from "./NodeSelector-status.tsx";

/**
 * Compact org-wallet nudge shown under the node list when the active node is a
 * managed (Ryu Cloud) one (epic #496, Unit C2). Managed inference is metered to
 * the org wallet (B4), so the user needs the balance visible where they pick the
 * node. Clicking opens the full Credits surface (`/credits`). Renders nothing
 * when the user is signed out / has no managed wallet, so a local-only install
 * shows no wallet row.
 */
function formatCreditResetDate(
	value: string | null | undefined
): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
	}).format(date);
}

export function ManagedNodeWallet({ node }: { node: Node | undefined }) {
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const tl = useLiteralMessages();
	const { activeOrgId, billing, organization } = useOrgBillingStatus();
	const { authed, wallet, entitlement, loading } = useCreditsWallet();

	// The warning belongs to the node the user is actually using. A different
	// configured cloud node must not make a local sidebar look billable.
	if (
		!(node?.managed && authed && entitlement?.managedInference) ||
		(node?.orgId && activeOrgId && node.orgId !== activeOrgId)
	) {
		return null;
	}

	const currency = wallet?.currency ?? "usd";
	const balanceLabel =
		wallet && !loading ? formatMicroUsd(wallet.balanceMicroUsd, currency) : "—";
	const status =
		wallet && !loading
			? creditBalanceStatus({
					balanceMicroUsd: wallet.balanceMicroUsd,
					monthlyCreditPoolMicroUsd: entitlement.monthlyCreditPoolMicroUsd,
				})
			: null;
	const warning = status?.kind === "low" || status?.kind === "empty";
	const resetDate = formatCreditResetDate(
		billing?.subscription?.currentPeriodEnd
	);
	const organizationLabel = organization?.name ?? "Organization wallet";
	const warningLabel =
		status?.kind === "empty"
			? "Credits empty"
			: status?.kind === "low"
				? tl("{percent}% credits remaining", {
						percent: status.remainingPercent,
					})
				: "Cloud credits";
	const openCredits = () => openSettings("credits");

	const cssVariables2: LayoutCssVariables = {
		"--desktop-inline2-width": `${status?.remainingPercent ?? 0}%`,
	};
	return (
		<div
			className={cn(
				"mt-1 rounded-xl text-xs",
				warning
					? "border border-warning/30 bg-warning/10 text-status-warning dark:text-status-warning"
					: "text-muted-foreground"
			)}
			data-credit-state={status?.kind ?? "loading"}
			data-testid="managed-node-wallet"
		>
			<button
				className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-accent/50 hover:text-foreground"
				onClick={openCredits}
				type="button"
			>
				<HugeiconsIcon
					className="shrink-0"
					icon={warning ? Alert02Icon : DollarCircleIcon}
					size={13}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate" title={warningLabel}>
						{warningLabel}
					</span>
					<span
						className="truncate text-muted-foreground/70 text-xs"
						title={organizationLabel}
					>
						{organizationLabel}
					</span>
				</span>
				<span className="shrink-0 font-heading font-medium tabular-nums">
					{balanceLabel}
				</span>
			</button>
			{warning && status ? (
				<div className="space-y-2 px-2 pb-2">
					<div
						aria-label="Credits remaining"
						aria-valuemax={100}
						aria-valuemin={0}
						aria-valuenow={status.remainingPercent}
						className="h-1.5 overflow-hidden rounded-full bg-warning/20"
						role="progressbar"
					>
						<div
							className={cn(
								cn("h-full rounded-full bg-warning", layoutStyles.authored1),
								layoutStyles.inline2
							)}
							style={cssVariables2}
						/>
					</div>
					<div className="flex items-center justify-between gap-2 text-xs">
						<span className="truncate text-muted-foreground">
							{resetDate
								? tl("Resets {resetDate}", { resetDate })
								: "Shared organization wallet"}
						</span>
						<button
							className="shrink-0 rounded-md bg-background/70 px-2 py-1 font-medium text-foreground hover:bg-background"
							onClick={openCredits}
							type="button"
						>
							Add credits
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/** Strip the `cloud-` prefix the store adds so the label reads as the raw name. */
function cloudLabel(name: string): string {
	return displayName(name.replace(/^cloud-/, ""));
}

/**
 * "Add this" nudge for cloud instances tied to the active workspace that the
 * user can reach but hasn't added yet (A4 follow-up). The store detects them
 * from the control plane ({@link useNodeStore.suggestedCloudNodes}); here the
 * user adds one (persists it as a Cloud node) or dismisses it. Renders nothing
 * when there is nothing to suggest, so a local-only / fully-added setup is quiet.
 */
export function CloudSuggestions({ compact = false }: { compact?: boolean }) {
	const suggestions = useNodeStore((s) => s.suggestedCloudNodes);
	const addSuggestedNode = useNodeStore((s) => s.addSuggestedNode);
	const dismissSuggestion = useNodeStore((s) => s.dismissSuggestion);
	const tl = useLiteralMessages();
	const [addingUrl, setAddingUrl] = useState<string | null>(null);

	if (suggestions.length === 0) {
		return null;
	}

	const handleAdd = async (node: Node) => {
		setAddingUrl(node.url);
		try {
			await addSuggestedNode(node);
			sileo.success({ title: `Added ${cloudLabel(node.name)}` });
		} catch {
			sileo.error({ title: "Couldn't add cloud computer" });
		} finally {
			setAddingUrl(null);
		}
	};

	return (
		<div className={cn("space-y-0.5", compact ? "px-1 py-0.5" : "mt-1")}>
			<p className="px-2 pt-0.5 pb-1 font-medium text-muted-foreground/70 text-xs">
				Available in your workspace
			</p>
			{suggestions.map((node) => {
				const busy = addingUrl === node.url;
				return (
					<div
						className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-accent/40"
						key={node.url}
					>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={CloudServerIcon}
							size={13}
						/>
						<span className="min-w-0 flex-1 truncate" title={node.url}>
							{cloudLabel(node.name)}
						</span>
						<button
							className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-primary text-xs hover:bg-primary/10 disabled:opacity-50"
							disabled={busy}
							onClick={() => handleAdd(node)}
							type="button"
						>
							{busy ? "Adding…" : "Add"}
						</button>
						<button
							aria-label={tl("Dismiss {name}", { name: cloudLabel(node.name) })}
							className="relative shrink-0 rounded-md p-0.5 text-muted-foreground/70 after:absolute after:-inset-1 hover:bg-muted hover:text-foreground disabled:opacity-50"
							disabled={busy}
							onClick={() => dismissSuggestion(node.url)}
							title="Dismiss"
							type="button"
						>
							<HugeiconsIcon icon={Cancel01Icon} size={11} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
