// Detail dialog for one vault value: metadata, gated reveal, version history
// with rollback, and restore. A revealed value lives only in this component's
// state, is hidden again after a short timeout, and is dropped when the dialog
// closes (the body unmounts). It never goes through React Query, whose caches
// would outlive the dialog.

import {
	ArrowTurnBackwardIcon,
	RestoreBinIcon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultVersions,
	restoreVaultSecret,
	revealVaultSecret,
	rollbackVaultSecret,
	setVaultSecret,
	type VaultSecret,
	vaultCoordsOf,
} from "@/src/lib/api/vault.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	isStaleVersion,
	readWithStepUp,
	vaultErrorMessage,
} from "./vault-errors.ts";
import {
	fromDateTimeLocal,
	parseTags,
	ROOT_FOLDER,
	rotationDaysText,
	rotationSecsFromDays,
	STATUS_COPY,
	secretKey,
	toDateTimeLocal,
} from "./vault-view.ts";

/** How long a revealed value stays on screen before it is hidden again. */
const REVEAL_TIMEOUT_MS = 30_000;
/** `${NAME}`, built so it is not mistaken for a template placeholder. */
const REFERENCE_EXAMPLE = ["$", "{NAME}"].join("");

interface VaultSecretDialogProps {
	onOpenChange: (open: boolean) => void;
	secret: VaultSecret | null;
	target: ApiTarget;
}

export function VaultSecretDialog({
	onOpenChange,
	secret,
	target,
}: VaultSecretDialogProps) {
	return (
		<Dialog onOpenChange={onOpenChange} open={secret !== null}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				{secret ? (
					<SecretDetail
						key={secretKey(secret)}
						onDone={() => onOpenChange(false)}
						secret={secret}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function formatWhen(value: string | null): string {
	if (!value) {
		return "unknown";
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "unknown" : formatDateTime(value);
}

function SecretDetail({
	onDone,
	secret,
	target,
}: {
	onDone: () => void;
	secret: VaultSecret;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const stepUp = useStepUp();
	const coords = vaultCoordsOf(secret);
	const canRead = secret.capabilities.includes("read");
	const canWrite = secret.capabilities.includes("write");
	const isDeleted = secret.status === "deleted";

	const [description, setDescription] = useState(secret.metadata.description);
	const [tagsText, setTagsText] = useState(secret.metadata.tags.join(", "));
	const [expiresAt, setExpiresAt] = useState(
		toDateTimeLocal(secret.metadata.expiresAt)
	);
	const [rotationDays, setRotationDays] = useState(
		rotationDaysText(secret.metadata.rotationPeriodSecs)
	);
	const [expandReferences, setExpandReferences] = useState(
		secret.metadata.expandReferences
	);
	const [revealed, setRevealed] = useState<string | null>(null);
	const [revealing, setRevealing] = useState(false);
	const [revealError, setRevealError] = useState<string | null>(null);

	useEffect(() => {
		if (revealed === null) {
			return;
		}
		const timer = window.setTimeout(() => setRevealed(null), REVEAL_TIMEOUT_MS);
		return () => window.clearTimeout(timer);
	}, [revealed]);

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: ["vault"] });
	};

	const versionsQuery = useQuery({
		queryKey: ["vault", "versions", target.url, secretKey(secret)],
		queryFn: () => listVaultVersions(target, secret.name, coords),
	});

	const saveMutation = useMutation({
		mutationFn: async () => {
			const result = await setVaultSecret(target, secret.name, {
				...coords,
				expectedVersion: secret.version,
				metadata: {
					description: description.trim(),
					tags: parseTags(tagsText),
					expiresAt: fromDateTimeLocal(expiresAt),
					rotationPeriodSecs: rotationSecsFromDays(rotationDays),
					expandReferences,
				},
			});
			return result.kind;
		},
		onSuccess: async (kind) => {
			await invalidate();
			sileo.success({
				title: kind === "pending" ? "Sent for approval" : "Details saved",
			});
			onDone();
		},
	});

	const rollbackMutation = useMutation({
		mutationFn: (version: number) =>
			rollbackVaultSecret(target, secret.name, coords, version),
		onSuccess: async (_, version) => {
			await invalidate();
			sileo.success({
				title: tl("Rolled back to version {version}", { version }),
			});
			onDone();
		},
	});

	const restoreMutation = useMutation({
		mutationFn: () => restoreVaultSecret(target, secret.name, coords),
		onSuccess: async () => {
			await invalidate();
			sileo.success({ title: "Secret restored" });
			onDone();
		},
	});

	const reveal = async () => {
		setRevealError(null);
		setRevealing(true);
		try {
			// A shared value asks for a confirmation when no organization or team
			// node vouches for the reveal. A dismissed prompt reveals nothing.
			const value = await readWithStepUp(stepUp.guard, () =>
				revealVaultSecret(target, secret.name, coords)
			);
			if (value !== null) {
				setRevealed(value);
			}
		} catch (error) {
			setRevealError(vaultErrorMessage(error, "Could not reveal this value."));
		} finally {
			setRevealing(false);
		}
	};

	const statusCopy =
		secret.status === "active" ? null : STATUS_COPY[secret.status];
	const saveError = saveMutation.error
		? isStaleVersion(saveMutation.error)
			? "This secret changed since you opened it. Refresh and try again."
			: vaultErrorMessage(saveMutation.error, "Could not save details.")
		: null;
	const actionError = rollbackMutation.error ?? restoreMutation.error;

	return (
		<div className="flex flex-col gap-5">
			{stepUp.dialog}
			<DialogHeader>
				<DialogTitle typography="code">{secret.name}</DialogTitle>
				<DialogDescription>
					{secret.path === ROOT_FOLDER
						? tl("{environment} · version {version}", {
								environment: secret.environment,
								version: secret.version,
							})
						: tl("{environment} · {path} · version {version}", {
								environment: secret.environment,
								path: secret.path,
								version: secret.version,
							})}
				</DialogDescription>
				<div className="flex flex-wrap gap-1.5 pt-1">
					{statusCopy ? (
						<Badge variant={statusCopy.variant}>{statusCopy.label}</Badge>
					) : null}
					{secret.source === "control-plane" ? (
						<Badge variant="outline">Shared</Badge>
					) : null}
				</div>
			</DialogHeader>

			<section aria-labelledby="vault-detail-value" className="space-y-2">
				<h3 className="font-medium text-sm" id="vault-detail-value">
					Value
				</h3>
				{canRead ? (
					<div className="flex items-center gap-2">
						<Input
							aria-label={tl("{name} value", { name: secret.name })}
							readOnly
							type={revealed === null ? "password" : "text"}
							value={revealed ?? "••••••••••••"}
							variant="code"
						/>
						{revealed === null ? (
							<Button
								disabled={revealing || isDeleted}
								loading={revealing}
								onClick={reveal}
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={ViewIcon} />
								Reveal
							</Button>
						) : (
							<Button onClick={() => setRevealed(null)} variant="outline">
								<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
								Hide
							</Button>
						)}
					</div>
				) : (
					<p className="text-muted-foreground text-xs">
						You can use this value but not view it.
					</p>
				)}
				{revealed === null ? null : (
					<p className="text-muted-foreground text-xs">
						Hidden again in 30 seconds or when you close this.
					</p>
				)}
				{revealError ? (
					<p className="text-status-destructive text-xs">{revealError}</p>
				) : null}
			</section>

			<section aria-labelledby="vault-detail-meta" className="space-y-3">
				<h3 className="font-medium text-sm" id="vault-detail-meta">
					Details
				</h3>
				<div className="space-y-1.5">
					<Label htmlFor="vault-detail-description">Description</Label>
					<Input
						disabled={!canWrite}
						id="vault-detail-description"
						maxLength={512}
						onChange={(event) => setDescription(event.target.value)}
						value={description}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-detail-tags">Tags</Label>
					<Input
						disabled={!canWrite}
						id="vault-detail-tags"
						onChange={(event) => setTagsText(event.target.value)}
						placeholder="ci, payments"
						value={tagsText}
					/>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="vault-detail-expires">Expires</Label>
						<Input
							disabled={!canWrite}
							id="vault-detail-expires"
							onChange={(event) => setExpiresAt(event.target.value)}
							type="datetime-local"
							value={expiresAt}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="vault-detail-rotation">Rotate every (days)</Label>
						<Input
							disabled={!canWrite}
							id="vault-detail-rotation"
							inputMode="decimal"
							onChange={(event) => setRotationDays(event.target.value)}
							placeholder="Never"
							value={rotationDays}
						/>
					</div>
				</div>
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<Label htmlFor="vault-detail-expand">Expand references</Label>
						<p className="text-muted-foreground text-xs">
							Replace <code className="font-mono">{REFERENCE_EXAMPLE}</code>{" "}
							with other vault values when used.
						</p>
					</div>
					<Switch
						checked={expandReferences}
						disabled={!canWrite}
						id="vault-detail-expand"
						onCheckedChange={(checked: boolean) => setExpandReferences(checked)}
					/>
				</div>
				{canWrite ? (
					<div className="flex justify-end">
						<Button
							disabled={saveMutation.isPending || isDeleted}
							loading={saveMutation.isPending}
							onClick={() => saveMutation.mutate()}
							variant="mono"
						>
							Save details
						</Button>
					</div>
				) : null}
				{saveError ? (
					<p className="text-sm text-status-destructive">{saveError}</p>
				) : null}
			</section>

			<section aria-labelledby="vault-detail-versions" className="space-y-2">
				<h3 className="font-semibold text-sm" id="vault-detail-versions">
					Versions
				</h3>
				{versionsQuery.error ? (
					<p className="text-status-destructive text-xs">
						{vaultErrorMessage(versionsQuery.error, "Could not load versions.")}
					</p>
				) : versionsQuery.isLoading ? (
					<p className="text-muted-foreground text-xs">Loading versions…</p>
				) : (
					<ul className="divide-y divide-border">
						{(versionsQuery.data ?? []).map((version) => (
							<li
								className="flex items-center justify-between gap-3 py-2"
								key={version.version}
							>
								<div className="min-w-0 text-xs">
									<p className="flex items-center gap-1.5 font-medium text-sm">
										v{version.version}
										{version.current ? (
											<span className="font-normal text-detail text-muted-foreground">
												Current
											</span>
										) : null}
										{version.destroyed ? (
											<Badge variant="outline">Destroyed</Badge>
										) : null}
									</p>
									<p className="truncate text-muted-foreground">
										{formatWhen(version.createdAt)}
										{version.createdBy ? ` · ${version.createdBy}` : ""} ·{" "}
										{version.source}
									</p>
								</div>
								{canWrite &&
								!(version.current || version.destroyed || isDeleted) ? (
									<Button
										disabled={rollbackMutation.isPending}
										onClick={() => rollbackMutation.mutate(version.version)}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon
											className="size-4"
											icon={ArrowTurnBackwardIcon}
										/>
										Roll back
									</Button>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>

			{isDeleted && canWrite ? (
				<div className="flex items-center justify-between gap-6 border-border border-t pt-4">
					<p className="text-muted-foreground text-xs">
						{tl("Deleted {when}. Restore it to use it again.", {
							when: formatWhen(secret.deletedAt),
						})}
					</p>
					<Button
						disabled={restoreMutation.isPending}
						loading={restoreMutation.isPending}
						onClick={() => restoreMutation.mutate()}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={RestoreBinIcon} />
						Restore
					</Button>
				</div>
			) : null}
			{actionError ? (
				<p className="text-sm text-status-destructive">
					{vaultErrorMessage(actionError, "That did not work.")}
				</p>
			) : null}
		</div>
	);
}
