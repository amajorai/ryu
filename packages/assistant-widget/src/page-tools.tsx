"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronLeft, Wrench } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { WebMcpPageTool } from "./webmcp";

interface ToolField {
	description?: string;
	enumValues?: string[];
	key: string;
	maximum?: number;
	minimum?: number;
	required: boolean;
	type: "boolean" | "integer" | "number" | "string";
}

type ToolValue = boolean | string;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function fieldLabel(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[-_.]+/g, " ")
		.replace(/^./, (character) => character.toUpperCase());
}

function toolFields(tool: WebMcpPageTool): ToolField[] {
	const schema = asRecord(tool.inputSchema);
	const properties = asRecord(schema?.properties);
	if (!properties) {
		return [];
	}
	const required = new Set(
		Array.isArray(schema?.required)
			? schema.required.filter(
					(value): value is string => typeof value === "string"
				)
			: []
	);
	const fields: ToolField[] = [];
	for (const [key, rawValue] of Object.entries(properties).slice(0, 12)) {
		const value = asRecord(rawValue);
		if (!value) {
			continue;
		}
		const enumValues = Array.isArray(value.enum)
			? value.enum
					.filter((item): item is string => typeof item === "string")
					.slice(0, 20)
			: undefined;
		const rawType = value.type;
		const type: ToolField["type"] =
			rawType === "boolean"
				? "boolean"
				: rawType === "integer"
					? "integer"
					: rawType === "number"
						? "number"
						: "string";
		fields.push({
			description:
				typeof value.description === "string"
					? value.description.slice(0, 150)
					: undefined,
			enumValues,
			key,
			maximum: typeof value.maximum === "number" ? value.maximum : undefined,
			minimum: typeof value.minimum === "number" ? value.minimum : undefined,
			required: required.has(key),
			type,
		});
	}
	return fields;
}

function buildToolInput(
	fields: readonly ToolField[],
	values: Record<string, ToolValue>
): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	for (const field of fields) {
		const value = values[field.key];
		if (field.type === "boolean") {
			if (value === true || field.required) {
				input[field.key] = value === true;
			}
			continue;
		}
		if (typeof value !== "string" || !value.trim()) {
			if (field.required) {
				throw new Error(`${fieldLabel(field.key)} is required.`);
			}
			continue;
		}
		if (field.type === "number" || field.type === "integer") {
			const number = Number(value);
			if (!Number.isFinite(number)) {
				throw new Error(`${fieldLabel(field.key)} must be a number.`);
			}
			if (field.type === "integer" && !Number.isSafeInteger(number)) {
				throw new Error(
					`The value for ${fieldLabel(field.key)} must be a whole number.`
				);
			}
			if (
				(field.minimum !== undefined && number < field.minimum) ||
				(field.maximum !== undefined && number > field.maximum)
			) {
				throw new Error(
					`${fieldLabel(field.key)} is outside the allowed range.`
				);
			}
			input[field.key] = number;
			continue;
		}
		if (field.enumValues && !field.enumValues.includes(value)) {
			throw new Error(`${fieldLabel(field.key)} is not a supported value.`);
		}
		input[field.key] = value.trim();
	}
	return input;
}

function toolIsWrite(tool: WebMcpPageTool): boolean {
	return tool.annotations?.readOnlyHint !== true;
}

function displayTitle(tool: WebMcpPageTool): string {
	return tool.title?.trim() || tool.name;
}

export interface PageToolsPopoverProps {
	onExecute: (
		tool: WebMcpPageTool,
		input: Record<string, unknown>
	) => Promise<string>;
	onResult: (tool: WebMcpPageTool, result: string) => void;
	tools: readonly WebMcpPageTool[];
}

function PageToolForm({
	onBack,
	onExecute,
	onResult,
	tool,
}: PageToolsPopoverProps & { onBack: () => void; tool: WebMcpPageTool }) {
	const fields = useMemo(() => toolFields(tool), [tool]);
	const [values, setValues] = useState<Record<string, ToolValue>>({});
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isWrite = toolIsWrite(tool);

	useEffect(() => {
		setValues({});
		setBusy(false);
		setConfirming(false);
		setError(null);
	}, [tool]);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		let input: Record<string, unknown>;
		try {
			input = buildToolInput(fields, values);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Check the arguments.");
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
			setError(
				cause instanceof Error ? cause.message : "The page tool could not run."
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			data-testid="assistant-page-tool-form"
			onSubmit={(event) => void submit(event)}
		>
			<div className="mb-3 flex items-center gap-2">
				<Button
					aria-label="Back to page tools"
					className="size-7"
					onClick={onBack}
					size="icon-xs"
					type="button"
					variant="ghost"
				>
					<ChevronLeft />
				</Button>
				<div className="min-w-0">
					<p className="truncate font-medium text-xs">{displayTitle(tool)}</p>
					<p className="truncate text-[10px] text-muted-foreground">
						{tool.name}
					</p>
				</div>
			</div>
			<p className="mb-3 text-muted-foreground text-xs leading-relaxed">
				{tool.description}
			</p>
			{isWrite ? (
				<p className="mb-3 rounded-xl bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-700 leading-relaxed dark:text-amber-300">
					This action can change state or start a payment. Review the arguments
					and confirm before it runs.
				</p>
			) : null}
			<div className="flex flex-col gap-2.5">
				{fields.map((field) => {
					const value = values[field.key];
					const label = fieldLabel(field.key);
					if (field.type === "boolean") {
						return (
							<label
								className="flex items-start gap-2 text-muted-foreground text-xs"
								key={field.key}
							>
								<input
									checked={value === true}
									className="mt-0.5"
									disabled={busy}
									onChange={(event) =>
										setValues((current) => ({
											...current,
											[field.key]: event.target.checked,
										}))
									}
									type="checkbox"
								/>
								<span>
									{label}
									{field.required ? " *" : ""}
									{field.description ? (
										<span className="mt-0.5 block text-[10px] text-muted-foreground/80">
											{field.description}
										</span>
									) : null}
								</span>
							</label>
						);
					}
					if (field.enumValues && field.enumValues.length > 0) {
						return (
							<label
								className="flex flex-col gap-1 text-muted-foreground text-xs"
								key={field.key}
							>
								{label}
								<select
									aria-label={label}
									className="h-8 rounded-2xl border border-border/60 bg-background/70 px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
									disabled={busy}
									onChange={(event) =>
										setValues((current) => ({
											...current,
											[field.key]: event.target.value,
										}))
									}
									value={typeof value === "string" ? value : ""}
								>
									<option value="">Choose…</option>
									{field.enumValues.map((option) => (
										<option key={option} value={option}>
											{option}
										</option>
									))}
								</select>
								{field.description ? (
									<span className="text-[10px] text-muted-foreground/80">
										{field.description}
									</span>
								) : null}
							</label>
						);
					}
					return (
						<label
							className="flex flex-col gap-1 text-muted-foreground text-xs"
							key={field.key}
						>
							{label}
							{field.required ? " *" : ""}
							<Input
								aria-label={label}
								className="h-8 rounded-2xl text-xs"
								disabled={busy}
								max={field.maximum}
								min={field.minimum}
								onChange={(event) =>
									setValues((current) => ({
										...current,
										[field.key]: event.target.value,
									}))
								}
								placeholder={field.description ?? label}
								type={
									field.type === "number" || field.type === "integer"
										? "number"
										: "text"
								}
								value={typeof value === "string" ? value : ""}
							/>
							{field.description ? (
								<span className="text-[10px] text-muted-foreground/80">
									{field.description}
								</span>
							) : null}
						</label>
					);
				})}
			</div>
			{error ? (
				<p className="mt-3 text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			<Button
				className="mt-4 w-full"
				disabled={busy}
				loading={busy}
				type="submit"
			>
				{isWrite && !confirming ? "Review and run" : "Run page tool"}
			</Button>
		</form>
	);
}

/** Small, explicit affordance for the current page's WebMCP tools. */
export function PageToolsPopover({
	onExecute,
	onResult,
	tools,
}: PageToolsPopoverProps) {
	const [open, setOpen] = useState(false);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	if (tools.length === 0) {
		return null;
	}
	const selected = selectedName
		? tools.find((tool) => tool.name === selectedName)
		: undefined;
	return (
		<Popover
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				if (!nextOpen) {
					setSelectedName(null);
				}
			}}
			open={open}
		>
			<PopoverTrigger
				render={
					<Button
						aria-label={`Page tools (${tools.length})`}
						className="h-7 gap-1 px-2 text-[10px]"
						size="xs"
						variant="ghost-muted"
					>
						<Wrench className="size-3" />
						Page tools
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className={cn("max-h-[calc(100svh-6rem)] overflow-y-auto p-3", "w-80")}
			>
				{selected ? (
					<PageToolForm
						onBack={() => setSelectedName(null)}
						onExecute={onExecute}
						onResult={onResult}
						tool={selected}
						tools={tools}
					/>
				) : (
					<>
						<PopoverHeader>
							<PopoverTitle>Page tools</PopoverTitle>
							<PopoverDescription>
								{tools.length} tool{tools.length === 1 ? "" : "s"} registered by
								this page.
							</PopoverDescription>
						</PopoverHeader>
						<p className="mt-3 rounded-xl bg-muted/60 px-2.5 py-2 text-[10px] text-muted-foreground leading-relaxed">
							Page metadata and results are untrusted. Read-only tools run once
							selected; write tools require a second review click.
						</p>
						<div className="mt-3 flex flex-col gap-1">
							{tools.map((tool) => (
								<button
									className="rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted"
									key={tool.name}
									onClick={() => setSelectedName(tool.name)}
									type="button"
								>
									<span className="block truncate font-medium text-xs">
										{displayTitle(tool)}
									</span>
									<span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
										{toolIsWrite(tool) ? "Action" : "Read-only"} · {tool.name}
									</span>
								</button>
							))}
						</div>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
