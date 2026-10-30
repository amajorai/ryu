import { CloudDownloadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { Dispatch, SetStateAction } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type {
	ComposioAction,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import { ArgumentField } from "./fields.tsx";
import { defaultArgumentValue } from "./model.ts";

type DestinationKind = "auto" | "page" | "database";

/** Pick a connected app, one of its read actions, its arguments and the destination. */
export function ComposioImportForm({
	actionName,
	argumentValues,
	availableToolkits,
	composioBusy,
	composioError,
	destinationKind,
	importTitle,
	onImport,
	readActions,
	selectedAction,
	setActionName,
	setArgumentValues,
	setDestinationKind,
	setImportTitle,
	setToolkit,
	toolkit,
}: {
	actionName: string;
	argumentValues: Record<string, string>;
	availableToolkits: ComposioToolkit[];
	composioBusy: boolean;
	composioError: string | null;
	destinationKind: DestinationKind;
	importTitle: string;
	onImport: () => void;
	readActions: ComposioAction[];
	selectedAction: ComposioAction | null;
	setActionName: (value: string) => void;
	setArgumentValues: Dispatch<SetStateAction<Record<string, string>>>;
	setDestinationKind: (value: DestinationKind) => void;
	setImportTitle: (value: string) => void;
	setToolkit: (value: string) => void;
	toolkit: string;
}) {
	const tl = useLiteralMessages();
	const selectedToolkitName = availableToolkits.find(
		(item) => item.slug === toolkit
	)?.name;
	return (
		<>
			<div className="grid gap-3 md:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="space-import-toolkit">Connected app</Label>
					<Select onValueChange={setToolkit} value={toolkit}>
						<SelectTrigger id="space-import-toolkit">
							<SelectValue placeholder="Choose an app">
								{(value) =>
									availableToolkits.find((item) => item.slug === value)?.name ??
									value
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{availableToolkits.map((item) => (
								<SelectItem key={item.slug} value={item.slug}>
									{item.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="space-import-action">Read action</Label>
					<Select onValueChange={setActionName} value={actionName}>
						<SelectTrigger id="space-import-action">
							<SelectValue placeholder="Choose data to import">
								{(value) =>
									readActions.find((item) => item.name === value)
										?.displayName ?? value
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{readActions.map((item) => (
								<SelectItem key={item.name} value={item.name}>
									{item.displayName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			{selectedAction?.description ? (
				<p className="text-muted-foreground text-xs">
					{selectedAction.description}
				</p>
			) : null}
			<div className="grid gap-3 md:grid-cols-2">
				{Object.entries(selectedAction?.inputSchema.properties ?? {}).map(
					([name, property]) => (
						<ArgumentField
							key={name}
							name={name}
							onChange={(value) =>
								setArgumentValues((current) => ({
									...current,
									[name]: value,
								}))
							}
							property={property}
							required={
								selectedAction?.inputSchema.required?.includes(name) ?? false
							}
							value={argumentValues[name] ?? defaultArgumentValue(property)}
						/>
					)
				)}
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="space-import-title">Title</Label>
					<Input
						id="space-import-title"
						onChange={(event) => setImportTitle(event.target.value)}
						placeholder={selectedAction?.displayName ?? "Imported data"}
						value={importTitle}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="space-import-destination">Destination</Label>
					<Select<"auto" | "page" | "database">
						onValueChange={(value) => setDestinationKind(value)}
						value={destinationKind}
					>
						<SelectTrigger id="space-import-destination">
							<SelectValue>
								{(value) => {
									if (value === "page") {
										return "Page";
									}
									if (value === "database") {
										return "Database";
									}
									return "Choose from result";
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">Choose from result</SelectItem>
							<SelectItem value="page">Page</SelectItem>
							<SelectItem value="database">Database</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
			{composioError ? <ErrorLine message={composioError} /> : null}
			<Button
				disabled={!selectedAction}
				loading={composioBusy}
				onClick={onImport}
				size="sm"
				type="button"
			>
				{composioBusy ? null : (
					<HugeiconsIcon className="size-4" icon={CloudDownloadIcon} />
				)}
				{selectedToolkitName === undefined || selectedToolkitName === null
					? tl("Import from app")
					: tl("Import from {name}", { name: selectedToolkitName })}
			</Button>
		</>
	);
}
