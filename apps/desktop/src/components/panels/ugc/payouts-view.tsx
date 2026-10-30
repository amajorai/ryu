import { Coins01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { useCallback, useEffect, useState } from "react";
import {
	type PayoutView as Payout,
	payoutViewSchema,
	readUgcList,
} from "../ugc-wire-contracts.ts";
import {
	describeError,
	formatCents,
	PAYOUT_STATUS_VARIANT,
	useUgcCall,
} from "./ugc-format.ts";
import {
	ErrorBanner,
	LoadingRow,
	PanelNotice,
	StatusPill,
} from "./ugc-primitives.tsx";

// ── Payouts ──────────────────────────────────────────────────────────────────

const PAYOUT_STATUS_FILTERS: Array<{ label: string; value: string }> = [
	{ label: "All payouts", value: "" },
	{ label: "Accrued", value: "accrued" },
	{ label: "Approved", value: "approved" },
	{ label: "Paid", value: "paid" },
];

/** The money-adjacent confirm. `approve` and `paid` are both one-way transitions
 *  the sidecar refuses to undo, so neither fires from a bare click — the repo's
 *  irreversible-action idiom (an `AlertDialog` naming the exact consequence). */
interface PendingPayoutAction {
	payout: Payout;
	step: "approve" | "paid";
}

export function PayoutsView({
	creatorName,
	invalidate,
	revision,
}: {
	creatorName: (id: string) => string;
	invalidate: () => void;
	revision: number;
}) {
	const call = useUgcCall();
	const [payouts, setPayouts] = useState<Payout[]>([]);
	const [statusFilter, setStatusFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingPayoutAction | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		const query = statusFilter ? `?status=${statusFilter}` : "";
		call(`/payouts${query}`)
			.then((data) => {
				if (cancelled) {
					return;
				}
				setPayouts(readUgcList(data, "payouts", payoutViewSchema));
				setError(null);
			})
			.catch((err) => {
				if (!cancelled) {
					setPayouts([]);
					setError(describeError(err));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [call, statusFilter, revision]);

	const commit = useCallback(
		async (action: PendingPayoutAction) => {
			setActionError(null);
			try {
				await call(
					`/payouts/${encodeURIComponent(action.payout.id)}/${action.step}`,
					{
						method: "POST",
					}
				);
				invalidate();
			} catch (err) {
				setActionError(describeError(err));
			}
		},
		[call, invalidate]
	);

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-2 p-3">
			<div className="flex items-center gap-2">
				<h2 className="font-semibold text-sm">Payouts</h2>
				<NativeSelect
					aria-label="Filter payouts by status"
					onChange={(e) => setStatusFilter(e.target.value)}
					size="sm"
					value={statusFilter}
				>
					{PAYOUT_STATUS_FILTERS.map((opt) => (
						<NativeSelectOption key={opt.value} value={opt.value}>
							{opt.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{error ? <ErrorBanner message={error} /> : null}
			{actionError ? <ErrorBanner message={actionError} /> : null}
			{loading && payouts.length === 0 ? <LoadingRow /> : null}
			{!(loading || error) && payouts.length === 0 ? (
				<PanelNotice>
					No payouts yet. Approving a submission accrues one automatically.
				</PanelNotice>
			) : null}
			{payouts.length > 0 ? (
				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
					<PayoutsTable
						creatorName={creatorName}
						onAct={setPending}
						payouts={payouts}
					/>
				</div>
			) : null}
			<ConfirmPayoutDialog
				action={pending}
				creatorName={creatorName}
				onConfirm={() => {
					const action = pending;
					setPending(null);
					if (action) {
						commit(action).catch(() => undefined);
					}
				}}
				onOpenChange={(next) => {
					if (!next) {
						setPending(null);
					}
				}}
			/>
		</section>
	);
}

function PayoutsTable({
	creatorName,
	onAct,
	payouts,
}: {
	creatorName: (id: string) => string;
	onAct: (action: PendingPayoutAction) => void;
	payouts: Payout[];
}) {
	return (
		<Table size="compact">
			<TableHeader>
				<TableRow>
					<TableHead size="compact">Creator</TableHead>
					<TableHead size="compact">Reason</TableHead>
					<TableHead size="compact">Status</TableHead>
					<TableHead className="text-right" size="compact">
						Amount
					</TableHead>
					<TableHead size="compact">
						<span className="sr-only">Payout actions</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{payouts.map((payout) => (
					<TableRow key={payout.id}>
						<TableCell spacing="compact">
							{creatorName(payout.creator_id)}
						</TableCell>
						<TableCell
							className="max-w-56"
							overflow="truncate"
							presentation="muted"
							spacing="compact"
						>
							{payout.reason || "—"}
						</TableCell>
						<TableCell spacing="compact">
							<StatusPill
								label={payout.status}
								variant={PAYOUT_STATUS_VARIANT.get(payout.status) ?? "outline"}
							/>
						</TableCell>
						<TableCell
							className="text-right"
							presentation="monospace-numeric"
							spacing="compact"
						>
							{formatCents(payout.amount_cents)}
						</TableCell>
						<TableCell className="text-right" spacing="compact">
							<PayoutRowAction onAct={onAct} payout={payout} />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function PayoutRowAction({
	onAct,
	payout,
}: {
	onAct: (action: PendingPayoutAction) => void;
	payout: Payout;
}) {
	if (payout.status === "accrued") {
		return (
			<Button
				onClick={() => onAct({ payout, step: "approve" })}
				size="xs"
				type="button"
				variant="secondary"
			>
				<HugeiconsIcon icon={Coins01Icon} />
				Approve
			</Button>
		);
	}
	if (payout.status === "approved") {
		return (
			<Button
				onClick={() => onAct({ payout, step: "paid" })}
				size="xs"
				type="button"
				variant="ghost"
			>
				Mark paid
			</Button>
		);
	}
	return <span className="text-muted-foreground">Settled</span>;
}

function ConfirmPayoutDialog({
	action,
	creatorName,
	onConfirm,
	onOpenChange,
}: {
	action: PendingPayoutAction | null;
	creatorName: (id: string) => string;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	const approving = action?.step === "approve";
	return (
		<AlertDialog onOpenChange={onOpenChange} open={action !== null}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{approving ? "Approve this payout?" : "Mark this payout as paid?"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{action ? (
							<>
								<span className="font-mono tabular-nums">
									{formatCents(action.payout.amount_cents)}
								</span>{" "}
								to {creatorName(action.payout.creator_id)}.{" "}
								{approving
									? "Approving clears it for payment; it can no longer be re-priced as views grow."
									: "Marking it paid also flips its submission to paid. This cannot be undone."}
							</>
						) : null}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>
						{approving ? "Approve payout" : "Mark paid"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
