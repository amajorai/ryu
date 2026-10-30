import { EngineFootnote } from "@ryu/blocks/desktop/store-engines.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { SandboxBackendEntry } from "@/src/hooks/useSandboxBackends.ts";
import {
	GROUP_LABELS,
	type PendingKind,
	type RowState,
	SANDBOX_PLATFORMS,
	sandboxDescription,
	unsupportedReason,
} from "./EnginesCatalogSection-model.ts";

export function SandboxEngineDetail({
	name,
	sandboxBackends,
	sandboxLoading,
	sandboxError,
	selectSandbox,
	rowState,
	runAction,
}: {
	name: string | undefined;
	sandboxBackends: SandboxBackendEntry[];
	sandboxLoading: boolean;
	sandboxError: string | null;
	selectSandbox: (name: string) => Promise<void>;
	rowState: (name: string) => RowState;
	runAction: (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	if (sandboxLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}
	const backend = sandboxBackends.find((b) => b.name === name);
	if (!backend) {
		return null;
	}
	const state = rowState(backend.name);
	const busy = state.pending !== null;
	const selectable = backend.supported;

	return (
		<ListingDetailShell
			actions={
				<label className="flex items-center gap-2 text-sm">
					Default backend
					<Switch
						aria-label={tl("Set {displayName} as the default sandbox backend", {
							displayName: backend.displayName,
						})}
						checked={backend.isDefault}
						disabled={!selectable || busy || backend.isDefault}
						onCheckedChange={() =>
							runAction(backend.name, "toggle", async () => {
								if (backend.isDefault) {
									return;
								}
								await selectSandbox(backend.name);
							})
						}
					/>
				</label>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Kind", value: GROUP_LABELS.sandbox },
							{ label: "Backend ID", value: backend.name },
							{
								label: "Detected",
								value: backend.detected ? "Yes" : "No",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					{...engineLogoProps(backend.name)}
					name={backend.displayName}
					statusIcons={
						<>
							{backend.isDefault ? (
								<StatusBadge kind="default" tone="hero" />
							) : null}
							{backend.supported ? null : (
								<StatusBadge
									kind="unavailable"
									label="Not supported on this platform"
									tone="hero"
								/>
							)}
						</>
					}
					tagline={sandboxDescription(backend)}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Type", value: GROUP_LABELS.sandbox },
						{
							label: "Runtime",
							value: backend.detected ? "Detected" : "Missing",
						},
						{
							label: "Default",
							value: backend.isDefault ? "Yes" : "No",
						},
						{
							label: "Supported",
							value: backend.supported ? "Yes" : "No",
						},
					]}
				/>
			}
		>
			<ListingSection title="How this backend behaves">
				<p className="text-muted-foreground text-sm leading-relaxed">
					Sandbox backends pick the default runtime the sandbox_exec tool uses
					when a call omits an explicit backend. Only one can be the default at
					a time.
				</p>
			</ListingSection>
			{backend.supported && !backend.detected && (
				<EngineFootnote tone="amber">
					Not detected on the node — calls fall back to unavailable until its
					runtime is installed.
				</EngineFootnote>
			)}
			{!backend.supported && (
				<EngineFootnote>
					{unsupportedReason(SANDBOX_PLATFORMS.get(backend.name) ?? [])}
				</EngineFootnote>
			)}
			{state.error && (
				<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
			)}
			{sandboxError && (
				<EngineFootnote tone="destructive">{sandboxError}</EngineFootnote>
			)}
		</ListingDetailShell>
	);
}
