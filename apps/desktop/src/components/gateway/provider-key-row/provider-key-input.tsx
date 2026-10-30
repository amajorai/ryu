import { EyeIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import type { Dispatch, SetStateAction } from "react";
import { ManagedKeyNote } from "./shared.tsx";

/** The key field with its save, show and clear controls, or the read-only note. */
export function ProviderKeyInput({
	accountCount,
	canConfigure,
	credentialLabel,
	handleAdd,
	handleSave,
	hasExternalCredentials,
	hasFleetCredentials,
	input,
	isSet,
	label,
	limitConfirmed,
	placeholder,
	readOnly,
	readOnlyNote,
	saving,
	setInput,
	setShowKey,
	showKey,
}: {
	accountCount: number;
	canConfigure: boolean;
	credentialLabel: string;
	handleAdd: () => Promise<void>;
	handleSave: () => Promise<void>;
	hasExternalCredentials: boolean;
	hasFleetCredentials: boolean;
	input: string;
	isSet: boolean;
	label: string;
	limitConfirmed: boolean;
	placeholder: string;
	readOnly: boolean;
	readOnlyNote: string;
	saving: boolean;
	setInput: Dispatch<SetStateAction<string>>;
	setShowKey: Dispatch<SetStateAction<boolean>>;
	showKey: boolean;
}) {
	return readOnly ? (
		<ManagedKeyNote note={readOnlyNote} />
	) : (
		<div className="flex w-full flex-wrap items-center gap-2 sm:flex-nowrap">
			<div className="relative min-w-0 basis-full sm:flex-1 sm:basis-auto">
				<Input
					aria-label={`${label} ${credentialLabel}`}
					disabled={hasFleetCredentials}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							handleSave();
						}
					}}
					placeholder={
						isSet ? "•••••••• (leave blank to keep current)" : placeholder
					}
					trailingAdornment="compact"
					type={showKey ? "text" : "password"}
					value={input}
				/>
				<button
					aria-label={showKey ? "Hide key" : "Show key"}
					className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					onClick={() => setShowKey((v) => !v)}
					type="button"
				>
					{showKey ? (
						<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
					) : (
						<HugeiconsIcon className="size-4" icon={EyeIcon} />
					)}
				</button>
			</div>
			<Button
				disabled={
					!(input.trim() && limitConfirmed) ||
					canConfigure === false ||
					hasFleetCredentials
				}
				loading={saving}
				onClick={() => handleSave()}
				size="sm"
				variant="outline"
			>
				{hasExternalCredentials
					? "Save local credential"
					: isSet
						? "Replace first key"
						: "Save"}
			</Button>
			{isSet && accountCount > 0 && !hasExternalCredentials ? (
				<Button
					disabled={!(input.trim() && limitConfirmed && canConfigure)}
					loading={saving}
					onClick={() => handleAdd()}
					size="sm"
					variant="secondary"
				>
					Add account
				</Button>
			) : null}
		</div>
	);
}
