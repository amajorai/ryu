"use client";

// Drag-to-assign on the gateway canvas (spec 07.6): a palette of the
// organization's policies that can be dragged onto a policy layer, and the
// confirmation that names the exact scope before anything is written. A
// palette chip also opens the confirmation from the keyboard, with the layer
// chosen there, so dragging is never the only way in.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { cn } from "@ryu/ui/lib/utils";
import { GripVertical } from "lucide-react";
import { type DragEvent, useId, useMemo, useState } from "react";
import type {
	CanvasAssignment,
	CanvasAssignTarget,
	CanvasNode,
} from "./model.ts";

/** The drag payload type: a policy id. */
export const POLICY_DRAG_TYPE = "application/x-ryu-canvas-policy";

/** Whether a drag carries a palette policy. */
export function carriesPolicy(event: DragEvent): boolean {
	return event.dataTransfer.types.includes(POLICY_DRAG_TYPE);
}

export interface AssignRequest {
	nodeId: string | null;
	policyId: string;
}

export function PolicyPalette({
	assignment,
	notice,
	onDragChange,
	onOpen,
}: {
	assignment: CanvasAssignment;
	/** The last assignment made, announced politely. */
	notice: string | null;
	onDragChange: (dragging: boolean) => void;
	onOpen: (request: AssignRequest) => void;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex max-h-56 w-56 flex-col gap-1.5 rounded-lg border border-border bg-background p-2 text-foreground"
			data-canvas-palette=""
		>
			<h3 className="px-1 font-medium text-xs" id={headingId}>
				Policies
			</h3>
			<p className="px-1 text-[11px] text-muted-foreground leading-snug">
				Drag one onto a policy layer, or select it to choose where it goes.
			</p>
			<ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
				{assignment.policies.map((policy) => (
					<li key={policy.id}>
						<button
							aria-label={tl("Assign {label}", { label: policy.label })}
							className={cn(
								"flex w-full cursor-grab items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-left text-xs",
								"outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing"
							)}
							data-canvas-policy={policy.id}
							draggable
							onClick={() => onOpen({ nodeId: null, policyId: policy.id })}
							onDragEnd={() => onDragChange(false)}
							onDragStart={(event) => {
								event.dataTransfer.setData(POLICY_DRAG_TYPE, policy.id);
								event.dataTransfer.effectAllowed = "copy";
								onDragChange(true);
							}}
							type="button"
						>
							<GripVertical
								aria-hidden="true"
								className="size-3 shrink-0 text-muted-foreground"
							/>
							<span className="min-w-0 flex-1 truncate">{policy.label}</span>
						</button>
					</li>
				))}
			</ul>
			<p
				aria-live="polite"
				className="px-1 text-[11px] text-status-success empty:hidden"
				role="status"
			>
				{notice}
			</p>
		</section>
	);
}

function targetKey(target: CanvasAssignTarget): string {
	return `${target.kind}:${target.id}`;
}

/**
 * Confirms a drop (or a palette selection) before writing. One scope per
 * confirmation; a refusal stays in the dialog so the viewer can pick another.
 */
export function AssignPolicyDialog({
	assignment,
	layers,
	onAssigned,
	onClose,
	request,
}: {
	assignment: CanvasAssignment;
	/** Policy layer nodes that take an assignment. */
	layers: readonly CanvasNode[];
	onAssigned: (message: string) => void;
	onClose: () => void;
	request: AssignRequest | null;
}) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open={request !== null}
		>
			<DialogContent>
				{request ? (
					<AssignForm
						assignment={assignment}
						key={`${request.policyId}:${request.nodeId ?? ""}`}
						layers={layers}
						onAssigned={onAssigned}
						onClose={onClose}
						request={request}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function AssignForm({
	assignment,
	layers,
	onAssigned,
	onClose,
	request,
}: {
	assignment: CanvasAssignment;
	layers: readonly CanvasNode[];
	onAssigned: (message: string) => void;
	onClose: () => void;
	request: AssignRequest;
}) {
	const tl = useLiteralMessages();
	const layerFieldId = useId();
	const targetFieldId = useId();
	const policy = assignment.policies.find(
		(entry) => entry.id === request.policyId
	);
	const [layerId, setLayerId] = useState<string | null>(
		request.nodeId ?? layers[0]?.id ?? null
	);
	const layer = layers.find((entry) => entry.id === layerId) ?? null;
	const targets = useMemo(
		() => (layer ? assignment.targets(layer) : []),
		[assignment, layer]
	);
	const [chosenTarget, setChosenTarget] = useState<string | null>(null);
	const target =
		targets.find((entry) => targetKey(entry) === chosenTarget) ??
		(targets.length === 1 ? targets[0] : undefined);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!policy) {
		return null;
	}

	const submit = async () => {
		if (!target) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const done = await assignment.assign(policy.id, target);
			if (done) {
				onAssigned(`Assigned ${policy.label} to ${target.label}.`);
				onClose();
			}
		} catch (assignError) {
			setError(
				assignError instanceof Error && assignError.message
					? assignError.message
					: "Could not assign the policy."
			);
		} finally {
			setBusy(false);
		}
	};

	const layerItems = layers.map((entry) => ({
		label: entry.label,
		value: entry.id,
	}));
	const targetItems = targets.map((entry) => ({
		label: entry.label,
		value: targetKey(entry),
	}));

	return (
		<>
			<DialogHeader>
				<DialogTitle>
					{tl("Assign {label}", { label: policy.label })}
				</DialogTitle>
				<DialogDescription>
					The policy applies to requests at the scope you choose. A scope holds
					one policy; to replace one, use the policy forms.
				</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor={layerFieldId}>Layer</Label>
					<Select
						disabled={busy}
						items={layerItems}
						onValueChange={(next: string | null) => {
							setLayerId(next);
							setChosenTarget(null);
							setError(null);
						}}
						value={layerId}
					>
						<SelectTrigger className="w-56" id={layerFieldId}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{layerItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{targets.length > 1 ? (
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor={targetFieldId}>Scope</Label>
						<Select
							disabled={busy}
							items={targetItems}
							onValueChange={(next: string | null) => {
								setChosenTarget(next);
								setError(null);
							}}
							value={chosenTarget}
						>
							<SelectTrigger className="w-56" id={targetFieldId}>
								<SelectValue placeholder="Choose one" />
							</SelectTrigger>
							<SelectContent>
								{targetItems.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				) : null}
				{targets.length === 1 && target ? (
					<p className="text-muted-foreground text-sm">
						{tl("Scope: {label}", { label: target.label })}
					</p>
				) : null}
				{layer && targets.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Nothing at this layer to assign to yet.
					</p>
				) : null}
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<DialogFooter>
				<Button
					disabled={busy}
					onClick={onClose}
					type="button"
					variant="secondary"
				>
					Cancel
				</Button>
				<Button
					disabled={busy || !target}
					loading={busy}
					onClick={() => {
						submit().catch(() => undefined);
					}}
					type="button"
				>
					Assign
				</Button>
			</DialogFooter>
		</>
	);
}
