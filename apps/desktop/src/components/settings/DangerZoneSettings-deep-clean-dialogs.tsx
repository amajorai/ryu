"use client";

import { useRichLiteralMessages } from "@ryu/i18n/react";
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
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	CLEAN_DEPTHS,
	CLEAN_PROFILES,
} from "@/src/components/settings/DangerZoneSettings-data.ts";

type CleanDepth = "none" | "state" | "full";

/** Deep clean, step 1: which profiles and how much of each to remove. */
export function DeepCleanOptionsDialog({
	cleanDepth,
	cleanProfiles,
	deepCleaning,
	deepCleanOptionsOpen,
	setCleanDepth,
	setDeepCleanOpen,
	setDeepCleanOptionsOpen,
	toggleCleanProfile,
}: {
	cleanDepth: CleanDepth;
	cleanProfiles: string[];
	deepCleaning: boolean;
	deepCleanOptionsOpen: boolean;
	setCleanDepth: (depth: CleanDepth) => void;
	setDeepCleanOpen: (open: boolean) => void;
	setDeepCleanOptionsOpen: (open: boolean) => void;
	toggleCleanProfile: (profile: string, on: boolean) => void;
}) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					setDeepCleanOptionsOpen(false);
				}
			}}
			open={deepCleanOptionsOpen}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Deep clean</DialogTitle>
					<DialogDescription>
						Pick what to remove. Every profile has its own data folder, gateway
						config and keychain slot, so cleaning one leaves the others
						untouched.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-5 py-1">
					<div className="flex flex-col gap-2">
						<span className="font-medium text-sm">Profiles to clean</span>
						<div className="grid grid-cols-2 gap-2">
							{CLEAN_PROFILES.map((p) => (
								<label
									className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
									htmlFor={`clean-profile-${p}`}
									key={p}
								>
									<Checkbox
										checked={cleanProfiles.includes(p)}
										id={`clean-profile-${p}`}
										onCheckedChange={(checked) =>
											toggleCleanProfile(p, checked === true)
										}
									/>
									{p}
								</label>
							))}
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<span className="font-medium text-sm">How much to remove</span>
						<Select<"none" | "state" | "full">
							items={CLEAN_DEPTHS.map((d) => ({
								label: d.label,
								value: d.value,
							}))}
							onValueChange={(v) => setCleanDepth(v)}
							value={cleanDepth}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CLEAN_DEPTHS.map((d) => (
									<SelectItem key={d.value} value={d.value}>
										{d.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-muted-foreground text-xs">
							{CLEAN_DEPTHS.find((d) => d.value === cleanDepth)?.description}
						</span>
					</div>
				</div>

				<DialogFooter>
					<Button
						onClick={() => setDeepCleanOptionsOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={cleanProfiles.length === 0 || deepCleaning}
						onClick={() => setDeepCleanOpen(true)}
						variant="destructive"
					>
						Continue
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Deep clean, step 2: confirm the chosen scope before anything is removed. */
export function DeepCleanConfirmDialog({
	cleanDepth,
	cleanProfiles,
	deepCleaning,
	deepCleanOpen,
	doDeepClean,
	setDeepCleanOpen,
}: {
	cleanDepth: CleanDepth;
	cleanProfiles: string[];
	deepCleaning: boolean;
	deepCleanOpen: boolean;
	doDeepClean: () => Promise<void>;
	setDeepCleanOpen: (open: boolean) => void;
}) {
	const tlRich = useRichLiteralMessages();
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					setDeepCleanOpen(false);
				}
			}}
			open={deepCleanOpen}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove these folders?</AlertDialogTitle>
					<AlertDialogDescription>
						{tlRich(
							"Ryu will stop, then permanently remove the<strong> {profiles} </strong>{count, plural, =1 {profile's} other {profiles'}} gateway config folder (gateway.toml and the pointer to its data folder){depth, select, state {, and clear its data folder while keeping downloaded engines and models} full {, and delete its entire data folder including downloaded engines and models} other {}}. Then it restarts and runs setup again. This cannot be undone.",
							{
								count: cleanProfiles.length,
								depth: cleanDepth,
								profiles: cleanProfiles.join(", "),
							},
							{ strong: (c) => <strong>{c}</strong> }
						)}
					</AlertDialogDescription>
					<AlertDialogDescription>
						<span className="text-status-warning">
							{cleanDepth === "none"
								? "Chats, spaces and memory live in the data folder and are NOT touched at this setting."
								: "The encryption key is kept: it is node identity, and there is no way to re-encrypt data without it."}
						</span>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deepCleaning}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={deepCleaning}
						onClick={() => {
							void doDeepClean();
						}}
					>
						{deepCleaning ? "Cleaning…" : "Remove them"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
