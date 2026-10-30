"use client";

import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { SubmitEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { z } from "zod";
import {
	buildToolInput,
	displayTitle,
	fieldLabel,
	type ToolField,
	type ToolValue,
	toolFields,
	toolIsWrite,
} from "./page-tools-schema.ts";
import { ASSISTANT_POPUP_LAYER } from "./skin.ts";
import type { WebMcpPageTool } from "./webmcp.ts";
import type { WebMcpRecord } from "./webmcp-contract.ts";

const stringValue = z.string().catch("");

/** A run failure: one sentence, with the raw message kept for "Copy details". */
interface RunFailure {
	details: string;
}

function ToolFieldControl({
	busy,
	field,
	onChange,
	value,
}: {
	busy: boolean;
	field: ToolField;
	onChange: (value: ToolValue) => void;
	value: ToolValue | undefined;
}) {
	const id = useId();
	const label = `${fieldLabel(field.key)}${field.required ? " *" : ""}`;
	const hint = field.description ? (
		<p className="text-detail text-muted-foreground">{field.description}</p>
	) : null;
	if (field.type === "boolean") {
		return (
			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<Checkbox
						checked={value === true}
						disabled={busy}
						id={id}
						onCheckedChange={(next) => onChange(next === true)}
					/>
					<Label className="font-normal text-sm" htmlFor={id}>
						{label}
					</Label>
				</div>
				{hint}
			</div>
		);
	}
	const options = field.enumValues ?? [];
	return (
		<div className="flex flex-col gap-1">
			<Label className="font-normal text-muted-foreground text-sm" htmlFor={id}>
				{label}
			</Label>
			{options.length > 0 ? (
				<Select
					disabled={busy}
					onValueChange={(next) => onChange(String(next))}
					value={stringValue.parse(value) || null}
				>
					<SelectTrigger aria-label={label} className="w-full" id={id}>
						<SelectValue placeholder="Choose…" />
					</SelectTrigger>
					<SelectContent
						data-ryu-assistant-widget="true"
						onMouseDown={(event) => event.stopPropagation()}
						positionerClassName={ASSISTANT_POPUP_LAYER}
					>
						{options.map((option) => (
							<SelectItem key={option} value={option}>
								{option}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : (
				<Input
					aria-label={label}
					disabled={busy}
					id={id}
					max={field.maximum}
					min={field.minimum}
					onChange={(event) => onChange(event.target.value)}
					type={
						field.type === "number" || field.type === "integer"
							? "number"
							: "text"
					}
					value={stringValue.parse(value)}
				/>
			)}
			{hint}
		</div>
	);
}

function copyDetails(details: string): void {
	navigator.clipboard?.writeText(details).catch(() => {
		// The host page may deny clipboard access; nothing else to do.
	});
}

export function PageToolForm({
	onBack,
	onExecute,
	onResult,
	tool,
}: {
	onBack: () => void;
	onExecute: (tool: WebMcpPageTool, input: WebMcpRecord) => Promise<string>;
	onResult: (tool: WebMcpPageTool, result: string) => void;
	tool: WebMcpPageTool;
}) {
	const fields = useMemo(() => toolFields(tool), [tool]);
	const [values, setValues] = useState<Record<string, ToolValue>>({});
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [invalid, setInvalid] = useState<string | null>(null);
	const [failure, setFailure] = useState<RunFailure | null>(null);
	const isWrite = toolIsWrite(tool);

	useEffect(() => {
		setValues({});
		setBusy(false);
		setConfirming(false);
		setInvalid(null);
		setFailure(null);
	}, [tool]);

	const run = async () => {
		setInvalid(null);
		setFailure(null);
		let input: WebMcpRecord;
		try {
			input = buildToolInput(fields, values);
		} catch (cause) {
			// Argument checks already read as sentences ("Path is required.").
			setInvalid(
				cause instanceof Error ? cause.message : "Check the arguments."
			);
			return;
		}
		if (isWrite && !confirming) {
			setConfirming(true);
			return;
		}
		setBusy(true);
		try {
			const result = await onExecute(tool, input);
			onResult(tool, result);
			onBack();
		} catch (cause) {
			setFailure({
				details: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			setBusy(false);
		}
	};
	const submit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		run().catch(() => undefined);
	};

	return (
		<form
			className="flex flex-col gap-3"
			data-testid="assistant-page-tool-form"
			onSubmit={submit}
		>
			<div className="flex items-center gap-2">
				<Button
					aria-label="Back to page tools"
					onClick={onBack}
					size="icon-sm"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</Button>
				<div className="min-w-0">
					<p className="truncate font-medium text-sm">{displayTitle(tool)}</p>
					<p
						className="truncate text-detail text-muted-foreground"
						title={`${tool.name} · ${tool.origin ?? "Current page"}`}
					>
						{tool.name} · {tool.origin ?? "Current page"}
					</p>
				</div>
			</div>
			{tool.description ? (
				<p className="text-detail text-muted-foreground">{tool.description}</p>
			) : null}
			{isWrite ? (
				<p className="rounded-lg bg-warning/10 px-3 py-2 text-detail text-status-warning">
					This tool can change things on the page. Review the arguments before
					it runs.
				</p>
			) : null}
			{fields.map((field) => (
				<ToolFieldControl
					busy={busy}
					field={field}
					key={field.key}
					onChange={(next) =>
						setValues((current) => ({ ...current, [field.key]: next }))
					}
					value={values[field.key]}
				/>
			))}
			{invalid ? (
				<p className="text-detail text-status-destructive" role="alert">
					{invalid}
				</p>
			) : null}
			{failure ? (
				<div className="flex items-center gap-2" role="alert">
					<p className="min-w-0 flex-1 text-detail text-status-destructive">
						The page tool couldn't run.
					</p>
					<Button
						onClick={() => copyDetails(failure.details)}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						Copy details
					</Button>
				</div>
			) : null}
			<Button
				disabled={busy}
				loading={busy}
				size="sm"
				type="submit"
				variant="mono"
			>
				{failure ? "Retry" : isWrite && !confirming ? "Review and run" : "Run"}
			</Button>
		</form>
	);
}
