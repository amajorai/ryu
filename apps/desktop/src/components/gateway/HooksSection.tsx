import {
	Alert02Icon,
	ArrowDown01Icon,
	CodeCircleIcon,
	Refresh01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CaptionInfo, StatusText } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayGovernance,
	type GovernanceScope,
	type HookPolicyOverride,
} from "@/src/lib/api/governance.ts";
import {
	fetchHookInventory,
	type HookInventory,
	type HookInventoryItem,
	updateHookOverride,
} from "@/src/lib/api/hooks.ts";
import {
	GovernanceScopeSwitcher,
	type GovernanceView,
} from "./GovernanceScopeSwitcher.tsx";
import { groupHookInventory, type HookPhaseGroup } from "./hooks-view.ts";
import { SettingsNotice } from "./SettingsNotice.tsx";

const hooksQueryKey = (target: ApiTarget) => [
	"hook-management",
	target.url,
	target.token,
];

const governanceQueryKey = (target: ApiTarget) => [
	"gateway-governance",
	target.url,
	target.token,
];

const localWriteScope = (
	view: GovernanceView
): Extract<GovernanceScope, "node" | "user"> | null => {
	switch (view) {
		case "effective":
		case "user":
			return "user";
		case "node":
			return "node";
		case "organization":
		case "team":
			return null;
	}
};

function HookMetadata({ hook }: { hook: HookInventoryItem }) {
	return (
		<dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[100px_minmax(0,1fr)]">
			<dt className="text-muted-foreground">Handler</dt>
			<dd>{hook.handler.display}</dd>
			{hook.handler.path ? (
				<>
					<dt className="text-muted-foreground">Source</dt>
					<dd className="break-all font-mono">{hook.handler.path}</dd>
				</>
			) : null}
			<dt className="text-muted-foreground">Matcher</dt>
			<dd className="break-words font-mono">
				{hook.matcher ? JSON.stringify(hook.matcher) : "All matching events"}
			</dd>
			<dt className="text-muted-foreground">Priority</dt>
			<dd className="tabular-nums">{hook.priority}</dd>
			<dt className="text-muted-foreground">Hook ID</dt>
			<dd className="break-all font-mono">{hook.id}</dd>
		</dl>
	);
}

function HookRow({
	canConfigure,
	hook,
	onUpdate,
	pending,
	view,
}: {
	canConfigure: boolean;
	hook: HookInventoryItem;
	onUpdate: (
		hook: HookInventoryItem,
		policy: HookPolicyOverride
	) => Promise<void>;
	pending: boolean;
	view: GovernanceView;
}) {
	const [open, setOpen] = useState(false);
	const tl = useLiteralMessages();
	const scope = localWriteScope(view);
	const localPolicy = scope ? hook.localOverrides[scope] : undefined;
	const enabled = localPolicy?.enabled ?? hook.enabled;
	const trusted = localPolicy?.trusted ?? hook.trusted;
	const canWrite =
		scope !== null && hook.pluginEnabled && (scope === "user" || canConfigure);
	const inherited =
		view !== "effective" &&
		((localPolicy?.enabled === undefined &&
			localPolicy?.trusted === undefined) ||
			scope === null);

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<div className="min-h-12 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<CollapsibleTrigger
						appearance="gateway-hook"
						aria-label={
							open
								? tl("Hide details for {hookId}", { hookId: hook.id })
								: tl("Show details for {hookId}", { hookId: hook.id })
						}
						className="flex min-w-0 flex-1 items-center text-left"
					>
						<span className="min-w-0 flex-1 truncate text-sm" title={hook.id}>
							{hook.id}
						</span>
						{inherited ? (
							<span className="text-muted-foreground text-xs">Inherited</span>
						) : null}
						<HugeiconsIcon
							aria-hidden
							className={cn(
								"size-3.5 shrink-0 text-muted-foreground transition-transform",
								open && "rotate-180"
							)}
							icon={ArrowDown01Icon}
						/>
					</CollapsibleTrigger>
					<Button
						aria-label={`${trusted ? "Remove trust from" : "Trust"} ${hook.id}`}
						disabled={!canWrite || pending}
						onClick={() =>
							onUpdate(hook, {
								...localPolicy,
								trusted: !trusted,
							})
						}
						size="sm"
						variant={trusted ? "secondary" : "outline"}
					>
						<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
						{trusted ? "Trusted" : "Trust"}
					</Button>
					<Switch
						aria-label={`${enabled ? "Disable" : "Enable"} ${hook.id}`}
						checked={enabled}
						disabled={!canWrite || pending || !trusted}
						onCheckedChange={(checked) =>
							onUpdate(hook, { ...localPolicy, enabled: checked })
						}
					/>
				</div>
				{hook.pluginEnabled ? null : (
					<p className="mt-1 text-muted-foreground text-xs">
						{tl("Enable {ownerName} before this hook can run.", {
							ownerName: hook.ownerName,
						})}
					</p>
				)}
				<CollapsibleContent spacing="gateway-detail">
					<HookMetadata hook={hook} />
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}

// A phase label inside its owner's card: the phase name with its description
// beneath, then the phase's hooks follow as sibling rows of the same group.
function HookPhaseHeader({ phase }: { phase: HookPhaseGroup }) {
	return (
		<div className="flex items-center gap-3 px-3 py-2">
			<div className="min-w-0 flex-1">
				<h4 className="font-medium text-foreground/70 text-xs">
					{phase.title}
				</h4>
				<p className="text-muted-foreground text-xs">{phase.description}</p>
			</div>
			{phase.hooks.some((hook) => hook.reviewRequired) ? (
				<HugeiconsIcon
					className="size-4 text-status-warning"
					icon={Alert02Icon}
				/>
			) : null}
		</div>
	);
}

export function HooksSection({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const tl = useLiteralMessages();
	const [view, setView] = useState<GovernanceView>("effective");
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	const [failedUpdate, setFailedUpdate] = useState<{
		hook: HookInventoryItem;
		policy: HookPolicyOverride;
		scope: Extract<GovernanceScope, "node" | "user">;
	} | null>(null);
	const hooksQuery = useQuery({
		queryKey: hooksQueryKey(target),
		queryFn: ({ signal }) => fetchHookInventory(target, signal),
		refetchInterval: 30_000,
	});
	const governanceQuery = useQuery({
		queryKey: governanceQueryKey(target),
		queryFn: ({ signal }) => fetchGatewayGovernance(target, signal),
	});
	const groups = groupHookInventory(hooksQuery.data?.hooks ?? []);

	const updatePolicy = async (
		hook: HookInventoryItem,
		policy: HookPolicyOverride,
		scopeOverride?: Extract<GovernanceScope, "node" | "user">
	) => {
		const scope = scopeOverride ?? localWriteScope(view);
		if (!scope) {
			return;
		}
		setPendingKey(hook.hookKey);
		setFailedUpdate(null);
		try {
			const inventory = await updateHookOverride(target, {
				hookKey: hook.hookKey,
				policy,
				scope,
			});
			queryClient.setQueryData<HookInventory>(hooksQueryKey(target), inventory);
		} catch {
			setFailedUpdate({ hook, policy, scope });
		} finally {
			setPendingKey(null);
		}
	};

	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Trust and enablement are enforced by Core before a hook can run."
						}
					>
						{"Lifecycle automation from your config and installed plugins."}
					</CaptionInfo>
				}
				headerAction={
					<Button
						aria-label="Refresh hooks"
						disabled={hooksQuery.isFetching}
						onClick={() => hooksQuery.refetch()}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon
							className={cn("size-4", hooksQuery.isFetching && "animate-spin")}
							icon={Refresh01Icon}
						/>
					</Button>
				}
				title="Hooks"
			>
				<GovernanceScopeSwitcher
					layers={governanceQuery.data?.layers ?? []}
					onValueChange={setView}
					value={view}
				/>
				<SettingsCard className="flex items-start gap-2 text-sm">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-status-warning"
						icon={Alert02Icon}
					/>
					<p>
						Hooks can act at lifecycle boundaries. Review newly installed or
						changed hooks before trusting them.
					</p>
				</SettingsCard>
				{failedUpdate ? (
					<SettingsNotice
						action={
							<Button
								disabled={pendingKey !== null}
								onClick={() =>
									void updatePolicy(
										failedUpdate.hook,
										failedUpdate.policy,
										failedUpdate.scope
									)
								}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						role="alert"
					>
						Hook policy could not be saved. Check the connection and retry.
					</SettingsNotice>
				) : null}
				{hooksQuery.isLoading ? (
					<SettingsCard>
						<SkeletonRows spacing="status" />
					</SettingsCard>
				) : null}
				{hooksQuery.error ? (
					<SettingsNotice
						action={
							<Button
								disabled={hooksQuery.isFetching}
								onClick={() => void hooksQuery.refetch()}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						role="alert"
						secondary={
							hooksQuery.error instanceof Error
								? hooksQuery.error.message
								: undefined
						}
					>
						Couldn’t load hooks.
					</SettingsNotice>
				) : null}
				{!(hooksQuery.isLoading || hooksQuery.error) && groups.length === 0 ? (
					<SettingsCard>
						<p className="py-3 text-muted-foreground text-sm">
							No hooks installed. Hooks from configuration and enabled plugins
							will appear here.
						</p>
					</SettingsCard>
				) : null}
			</SettingsSection>

			{groups.map((group) => (
				<SettingsSection key={group.source} title={group.label}>
					{group.owners.map((owner) => (
						<SettingsGroup key={owner.ownerId}>
							<SettingsItem
								actions={
									<span className="flex items-center gap-2">
										<span className="text-muted-foreground text-sm">
											{tl("{hookCount, plural, one {# hook} other {# hooks}}", {
												hookCount: owner.hookCount,
											})}
										</span>
										{owner.reviewCount > 0 ? (
											<StatusText tone="warning">
												{tl(
													"{reviewCount, plural, one {# needs review} other {# need review}}",
													{ reviewCount: owner.reviewCount }
												)}
											</StatusText>
										) : null}
									</span>
								}
								title={
									<span className="flex min-w-0 items-center gap-2">
										<SettingsIconTile icon={CodeCircleIcon} />
										<span className="truncate" title={owner.ownerName}>
											{owner.ownerName}
										</span>
									</span>
								}
							/>
							{owner.phases.flatMap((phase) => [
								<HookPhaseHeader key={`${phase.phase}-header`} phase={phase} />,
								...phase.hooks.map((hook) => (
									<HookRow
										canConfigure={canConfigure}
										hook={hook}
										key={hook.hookKey}
										onUpdate={updatePolicy}
										pending={pendingKey === hook.hookKey}
										view={view}
									/>
								)),
							])}
						</SettingsGroup>
					))}
				</SettingsSection>
			))}
		</div>
	);
}
