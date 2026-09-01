import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	InformationCircleIcon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group";
import { useEffect, useState } from "react";
import {
	CONNECTION_ACCESS_OPTIONS,
	type ConnectionAccessLevel,
	connectionAccessOption,
	DEFAULT_CONNECTION_ACCESS_LEVEL,
	normalizeConnectionAccessLevel,
} from "@/src/lib/connection-permissions.ts";

export function ConnectionPermissionDialog({
	connectionName,
	connectionType,
	currentLevel,
	onConfirm,
	onOpenChange,
	open,
}: {
	connectionName: string;
	connectionType: "Composio" | "MCP";
	currentLevel?: ConnectionAccessLevel | null;
	onConfirm: (level: ConnectionAccessLevel) => Promise<void>;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const [selected, setSelected] = useState<ConnectionAccessLevel>(
		normalizeConnectionAccessLevel(currentLevel)
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setSelected(normalizeConnectionAccessLevel(currentLevel));
			setError(null);
			setSaving(false);
		}
	}, [currentLevel, open]);

	const handleConfirm = async () => {
		setSaving(true);
		setError(null);
		try {
			await onConfirm(selected);
			onOpenChange(false);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The connection could not be started."
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl"
				data-testid="connection-permission-dialog"
				showCloseButton={!saving}
			>
				<DialogHeader>
					<div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-[0.12em]">
						<HugeiconsIcon className="size-4" icon={Shield01Icon} />
						<span>Connection review</span>
					</div>
					<DialogTitle>
						Review access before connecting {connectionName}
					</DialogTitle>
					<DialogDescription>
						Choose the maximum this {connectionType} account may do through Ryu.
						You can change the choice the next time you reconnect.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-start gap-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-3 text-sm">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
						icon={InformationCircleIcon}
					/>
					<div className="space-y-1">
						<p className="font-medium">This account may contain people data</p>
						<p className="text-muted-foreground text-xs leading-relaxed">
							Contacts, messages, customer records, coworkers, and HR details
							can all be sensitive. Start with Risk-based or Read only when you
							are unsure.
						</p>
					</div>
				</div>

				<RadioGroup
					aria-label="Connection access level"
					className="flex flex-col gap-2"
					onValueChange={(value) => {
						if (typeof value === "string") {
							setSelected(normalizeConnectionAccessLevel(value));
						}
					}}
					value={selected}
				>
					{CONNECTION_ACCESS_OPTIONS.map((option) => {
						const id = `connection-access-${option.id}`;
						const isSelected = selected === option.id;
						return (
							<label
								className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
									isSelected
										? "border-primary/60 bg-primary/5"
										: "border-border/70 hover:bg-muted/40"
								}`}
								htmlFor={id}
								key={option.id}
							>
								<RadioGroupItem
									className="mt-0.5"
									disabled={saving}
									id={id}
									value={option.id}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-2 font-medium text-sm">
										{option.label}
										{option.id === DEFAULT_CONNECTION_ACCESS_LEVEL ? (
											<Badge className="text-[10px]" variant="secondary">
												Default
											</Badge>
										) : null}
									</span>
									<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
										{option.description}
									</span>
								</span>
								{isSelected ? (
									<HugeiconsIcon
										className="mt-0.5 size-4 shrink-0 text-primary"
										icon={CheckmarkCircle02Icon}
									/>
								) : null}
							</label>
						);
					})}
				</RadioGroup>

				<div className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0"
						icon={Alert02Icon}
					/>
					<p>
						This Ryu policy is enforced before a connected account is used. The
						provider's own OAuth scopes and Ryu's separate tool approval checks
						still apply.
					</p>
				</div>

				{error ? (
					<p className="text-destructive text-xs" role="alert">
						{error}
					</p>
				) : null}

				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={saving} onClick={() => void handleConfirm()}>
						Continue to connect
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function accessLevelSummary(
	level: ConnectionAccessLevel | null | undefined
): string {
	return connectionAccessOption(level).shortLabel;
}
