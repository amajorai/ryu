import {
	ArrowRight01Icon,
	InformationCircleIcon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DialogFooter } from "@ryu/ui/components/dialog.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { PrivatePackageSharePreview } from "@/src/lib/api/marketplace.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import { ConnectionRow, ErrorNotice } from "./PrivatePackageParts.tsx";
import type { PrivatePackageInstallState } from "./use-private-package-install.ts";

/** Step two: the package preview, its connection setup and the install action. */
export function PrivatePackagePreview({
	onClose,
	preview,
	state,
}: {
	onClose: () => void;
	preview: PrivatePackageSharePreview;
	state: PrivatePackageInstallState;
}) {
	const tl = useLiteralMessages();
	const {
		canInstall,
		connectingId,
		error,
		handleInstall,
		loading,
		ready,
		requestConnection,
		setError,
		setInstallSession,
		setPreview,
		setStage,
		setupStatuses,
		stage,
		summary,
	} = state;
	return (
		<div className="space-y-5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="mb-1 flex flex-wrap items-center gap-2">
						<h3 className="font-medium text-lg">{preview.name}</h3>
						<Badge variant="secondary">
							{preview.kind.replaceAll("_", " ")}
						</Badge>
					</div>
					<p className="text-muted-foreground text-sm">
						{preview.description ?? "Private package shared with you"}
					</p>
				</div>
				<Badge
					className="shrink-0"
					spacing="relaxed"
					variant={
						preview.verification === "invalid" ? "destructive" : "outline"
					}
				>
					<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
					{preview.verification === "verified"
						? "Verified"
						: preview.verification === "unsigned"
							? "Unsigned release"
							: preview.verification === "invalid"
								? "Signature invalid"
								: "Verification unavailable"}
				</Badge>
			</div>
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
				<Badge variant="secondary">
					{preview.audience === "organization"
						? "Organization-bound"
						: "Shareable code"}
				</Badge>
				{preview.version ? (
					<span>{tl("Version {version}", { version: preview.version })}</span>
				) : null}
				{preview.expiresAt ? (
					<span>
						{tl("Expires {date}", { date: formatDate(preview.expiresAt) })}
					</span>
				) : null}
			</div>
			{preview.capabilities.length > 0 ? (
				<div className="border-border border-y py-3">
					<p className="mb-2 font-medium text-sm">Included capabilities</p>
					<div className="flex flex-wrap gap-1.5">
						{preview.capabilities.map((capability) => (
							<Badge key={capability} variant="outline">
								{capability}
							</Badge>
						))}
					</div>
				</div>
			) : null}

			<div className="rounded-xl bg-muted p-4">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<p className="font-medium text-sm">Connection setup</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{summary.required === 0
								? "No external accounts are required."
								: ready
									? "Everything required is connected."
									: tl(
											"{missing, plural, one {# required connection still needed} other {# required connections still needed}}",
											{ missing: summary.missing }
										)}
						</p>
					</div>
					{stage === "complete" ? (
						<Badge variant={ready ? "default" : "secondary"}>
							{ready ? "Ready to run" : "Finish setup"}
						</Badge>
					) : null}
				</div>
				{preview.connections.length > 0 ? (
					<div className="space-y-2">
						{preview.connections.map((requirement) => (
							<ConnectionRow
								connecting={connectingId === requirement.id}
								key={requirement.id}
								onConnect={() => requestConnection(requirement)}
								requirement={requirement}
								status={setupStatuses.get(requirement.id)}
							/>
						))}
					</div>
				) : null}
			</div>

			<div className="flex items-start gap-2 text-muted-foreground text-xs leading-5">
				<HugeiconsIcon
					className="mt-0.5 size-4 shrink-0"
					icon={InformationCircleIcon}
				/>
				<span>
					Installing adds the package definition to this node. Account
					authorization stays with you and is never included in the shared
					package.
				</span>
			</div>
			{canInstall ? null : (
				<div className="rounded-lg bg-destructive/10 px-3 py-3 text-sm text-status-destructive">
					{preview.verification === "unsigned"
						? "This release is not signed. Ask the publisher for a signed release before installing."
						: "Ryu could not verify this release, so installation is unavailable."}
				</div>
			)}

			{error ? <ErrorNotice message={error} /> : null}
			<DialogFooter purpose="package-list-actions">
				{stage === "complete" ? (
					<Button onClick={onClose} type="button">
						Done
					</Button>
				) : (
					<>
						<Button
							disabled={loading}
							onClick={() => {
								setStage("entry");
								setPreview(null);
								setInstallSession(null);
								setError(null);
							}}
							type="button"
							variant="ghost"
						>
							Use another code
						</Button>
						<Button
							disabled={loading || !canInstall}
							onClick={() => void handleInstall()}
							type="button"
						>
							{loading ? <Spinner className="size-4" /> : null}
							{loading ? "Installing…" : "Install package"}
							{loading ? null : (
								<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
							)}
						</Button>
					</>
				)}
			</DialogFooter>
		</div>
	);
}
