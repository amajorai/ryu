import {
	CheckmarkCircle02Icon,
	Copy01Icon,
	InformationCircleIcon,
	Key01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { marketplaceBrowseKindLabel } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	createPrivatePackageShareCode,
	type MarketplaceKind,
	type PrivatePackageShareCode,
	revokePrivatePackageShareCode,
} from "@/src/lib/api/marketplace.ts";

const SHAREABLE_KINDS: MarketplaceKind[] = [
	"agent",
	"app",
	"bundle",
	"output_style",
	"plugin",
	"profile",
	"skill",
	"space",
	"theme",
	"language_pack",
	"workflow",
];

type ShareAudience = "organization" | "shareable";

export default function PrivatePackageShareDialog({
	onClose,
	open,
}: {
	onClose: () => void;
	open: boolean;
}) {
	const [kind, setKind] = useState<MarketplaceKind>("workflow");
	const [id, setId] = useState("");
	const [label, setLabel] = useState("");
	const [audience, setAudience] = useState<ShareAudience>("organization");
	const [customerOrganizationId, setCustomerOrganizationId] = useState("");
	const [maxRedemptions, setMaxRedemptions] = useState("1");
	const [expiresInDays, setExpiresInDays] = useState("7");
	const [result, setResult] = useState<PrivatePackageShareCode | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [revoking, setRevoking] = useState(false);

	const reset = useCallback(() => {
		setKind("workflow");
		setId("");
		setLabel("");
		setAudience("organization");
		setCustomerOrganizationId("");
		setMaxRedemptions("1");
		setExpiresInDays("7");
		setResult(null);
		setError(null);
		setLoading(false);
		setRevoking(false);
	}, []);

	useEffect(() => {
		if (open) {
			reset();
		}
	}, [open, reset]);

	const handleCreate = async () => {
		const packageId = id.trim();
		const redemptions = Number.parseInt(maxRedemptions, 10);
		const days = Number.parseInt(expiresInDays, 10);
		if (!packageId) {
			setError(
				"Enter the package id exactly as it appears in the Marketplace."
			);
			return;
		}
		if (audience === "organization" && !customerOrganizationId.trim()) {
			setError(
				"Enter the customer organization id, or choose Shareable access."
			);
			return;
		}
		if (
			!Number.isInteger(redemptions) ||
			redemptions < 1 ||
			redemptions > 1000
		) {
			setError("Redemptions must be a whole number from 1 to 1,000.");
			return;
		}
		if (!Number.isInteger(days) || days < 1 || days > 90) {
			setError("Expiry must be between 1 and 90 days.");
			return;
		}
		setError(null);
		setLoading(true);
		try {
			const created = await createPrivatePackageShareCode({
				customerOrganizationId:
					audience === "organization" ? customerOrganizationId.trim() : null,
				expiresAt: new Date(
					Date.now() + days * 24 * 60 * 60 * 1000
				).toISOString(),
				id: packageId,
				kind,
				label: label.trim() || undefined,
				maxRedemptions: redemptions,
			});
			setResult(created);
			sileo.success({
				title: "Private package code created",
				description: "Copy it now. The plaintext code is only shown once.",
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not create the package code."
			);
		} finally {
			setLoading(false);
		}
	};

	const copyCode = async () => {
		if (!result?.code) {
			return;
		}
		try {
			await navigator.clipboard.writeText(result.code);
			sileo.success({
				title: "Code copied",
				description: "Send it to the customer securely.",
			});
		} catch {
			setError(
				"Clipboard access is unavailable. Select and copy the code manually."
			);
		}
	};

	const revokeCode = async () => {
		if (!result?.id || result.revokedAt) {
			return;
		}
		setError(null);
		setRevoking(true);
		try {
			await revokePrivatePackageShareCode(result.id);
			setResult({ ...result, revokedAt: new Date().toISOString() });
			sileo.success({
				title: "Code revoked",
				description: "It can no longer be redeemed.",
			});
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not revoke the code."
			);
		} finally {
			setRevoking(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HugeiconsIcon className="size-4 text-primary" icon={Key01Icon} />
						Create a private package code
					</DialogTitle>
					<DialogDescription>
						Create a time-limited code for a signed live Marketplace release.
						The customer authorizes their own integrations after install.
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="space-y-4">
						<div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-center">
							<div className="mb-2 flex items-center justify-center gap-2 text-primary text-sm">
								<HugeiconsIcon
									className="size-4"
									icon={CheckmarkCircle02Icon}
								/>
								Code ready
							</div>
							<p className="break-all font-medium font-mono text-2xl tracking-[0.18em]">
								{result.code}
							</p>
							<Button
								className="mt-4"
								onClick={() => void copyCode()}
								size="sm"
								variant="secondary"
							>
								<HugeiconsIcon className="size-4" icon={Copy01Icon} />
								Copy code
							</Button>
						</div>
						<div className="flex items-start gap-2 text-muted-foreground text-xs leading-5">
							<HugeiconsIcon
								className="mt-0.5 size-4 shrink-0"
								icon={InformationCircleIcon}
							/>
							<span>
								{result.revokedAt ? "This code is revoked. " : null}
								{result.customerOrganizationId
									? "This code is bound to the customer organization."
									: "Anyone with this code can redeem it."}{" "}
								It expires{" "}
								{result.expiresAt
									? new Date(result.expiresAt).toLocaleDateString()
									: "soon"}{" "}
								and allows {result.maxRedemptions} redemption
								{result.maxRedemptions === 1 ? "" : "s"}.
							</span>
						</div>
						{error ? <p className="text-destructive text-sm">{error}</p> : null}
						<DialogFooter className="gap-2">
							<Button
								disabled={revoking || Boolean(result.revokedAt)}
								onClick={() => void revokeCode()}
								variant="destructive"
							>
								{revoking ? <Spinner className="size-4" /> : null}
								{result.revokedAt ? "Revoked" : "Revoke code"}
							</Button>
							<Button onClick={onClose}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="space-y-4">
						<div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
							<label className="space-y-1.5" htmlFor="share-code-kind">
								<span className="font-medium text-sm">Package type</span>
								<Select
									items={SHAREABLE_KINDS.map((value) => ({
										label: marketplaceBrowseKindLabel(value),
										value,
									}))}
									onValueChange={(value) => {
										if (
											value &&
											SHAREABLE_KINDS.includes(value as MarketplaceKind)
										) {
											setKind(value as MarketplaceKind);
										}
									}}
									value={kind}
								>
									<SelectTrigger id="share-code-kind">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{SHAREABLE_KINDS.map((value) => (
											<SelectItem key={value} value={value}>
												{marketplaceBrowseKindLabel(value)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</label>
							<label className="space-y-1.5" htmlFor="share-code-id">
								<span className="font-medium text-sm">Package id</span>
								<Input
									id="share-code-id"
									onChange={(event) => setId(event.target.value)}
									placeholder="acme/customer-report"
									value={id}
								/>
							</label>
						</div>
						<label className="block space-y-1.5" htmlFor="share-code-label">
							<span className="font-medium text-sm">
								Label{" "}
								<span className="font-normal text-muted-foreground">
									(optional)
								</span>
							</span>
							<Input
								id="share-code-label"
								onChange={(event) => setLabel(event.target.value)}
								placeholder="Acme onboarding"
								value={label}
							/>
						</label>
						<label className="block space-y-1.5" htmlFor="share-code-audience">
							<span className="font-medium text-sm">Access</span>
							<Select
								items={[
									{
										label: "Organization-bound (recommended)",
										value: "organization",
									},
									{ label: "Shareable bearer code", value: "shareable" },
								]}
								onValueChange={(value) => {
									if (value === "organization" || value === "shareable") {
										setAudience(value);
									}
								}}
								value={audience}
							>
								<SelectTrigger id="share-code-audience">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="organization">
										Organization-bound (recommended)
									</SelectItem>
									<SelectItem value="shareable">
										Shareable bearer code
									</SelectItem>
								</SelectContent>
							</Select>
						</label>
						<label
							className="block space-y-1.5"
							htmlFor="share-code-customer-org"
						>
							<span className="font-medium text-sm">
								Customer organization id
							</span>
							<Input
								disabled={audience !== "organization"}
								id="share-code-customer-org"
								onChange={(event) =>
									setCustomerOrganizationId(event.target.value)
								}
								placeholder="org_…"
								value={customerOrganizationId}
							/>
							<span className="block text-muted-foreground text-xs">
								Organization-bound codes only redeem for members of this
								organization.
							</span>
						</label>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="space-y-1.5" htmlFor="share-code-expiry">
								<span className="font-medium text-sm">Expires in (days)</span>
								<Input
									id="share-code-expiry"
									inputMode="numeric"
									max={90}
									min={1}
									onChange={(event) => setExpiresInDays(event.target.value)}
									type="number"
									value={expiresInDays}
								/>
							</label>
							<label className="space-y-1.5" htmlFor="share-code-redemptions">
								<span className="font-medium text-sm">Max redemptions</span>
								<Input
									id="share-code-redemptions"
									inputMode="numeric"
									max={1000}
									min={1}
									onChange={(event) => setMaxRedemptions(event.target.value)}
									type="number"
									value={maxRedemptions}
								/>
							</label>
						</div>
						{error ? <p className="text-destructive text-sm">{error}</p> : null}
						<DialogFooter>
							<Button onClick={onClose} variant="ghost">
								Cancel
							</Button>
							<Button disabled={loading} onClick={() => void handleCreate()}>
								{loading ? <Spinner className="size-4" /> : null}
								Create code
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
