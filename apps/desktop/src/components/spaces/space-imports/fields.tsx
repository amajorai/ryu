import { Upload01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type ChangeEvent, type ReactNode, useRef } from "react";
import type { ComposioInputProperty } from "@/src/lib/api/composio.ts";

export function FileImportCard({
	accept,
	description,
	disabled,
	icon,
	id,
	onFiles,
	title,
}: {
	accept: string;
	description: string;
	disabled: boolean;
	icon: ReactNode;
	id: string;
	onFiles: (files: FileList) => void;
	title: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	const tl = useLiteralMessages();
	return (
		<Card className="h-full">
			<CardHeader spacing="chart">
				<div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					{icon}
				</div>
				<div>
					<CardTitle variant="section">{title}</CardTitle>
					<CardDescription className="mt-1">{description}</CardDescription>
				</div>
			</CardHeader>
			<CardContent>
				<input
					accept={accept}
					aria-label={tl("{title} files", { title })}
					className="sr-only"
					id={id}
					multiple
					onChange={(event: ChangeEvent<HTMLInputElement>) => {
						if (event.target.files?.length) {
							onFiles(event.target.files);
						}
						event.target.value = "";
					}}
					ref={input}
					type="file"
				/>
				<Button
					disabled={disabled}
					onClick={() => input.current?.click()}
					size="sm"
					type="button"
					variant="outline"
				>
					<HugeiconsIcon className="size-4" icon={Upload01Icon} />
					Choose files
				</Button>
			</CardContent>
		</Card>
	);
}

export function ArgumentField({
	name,
	onChange,
	property,
	required,
	value,
}: {
	name: string;
	onChange: (value: string) => void;
	property: ComposioInputProperty;
	required: boolean;
	value: string;
}) {
	const tl = useLiteralMessages();
	const label = property.title ?? name.replaceAll("_", " ");
	const type = Array.isArray(property.type) ? property.type[0] : property.type;
	if (property.enum?.length) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Select onValueChange={onChange} value={value}>
					<SelectTrigger id={`composio-${name}`}>
						<SelectValue placeholder={tl("Choose {label}", { label })} />
					</SelectTrigger>
					<SelectContent>
						{property.enum.map((option) => (
							<SelectItem key={String(option)} value={String(option)}>
								{String(option)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{property.description ? (
					<p className="text-muted-foreground text-xs">
						{property.description}
					</p>
				) : null}
			</div>
		);
	}
	if (type === "boolean") {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Select onValueChange={onChange} value={value}>
					<SelectTrigger id={`composio-${name}`}>
						<SelectValue placeholder={tl("Choose {label}", { label })} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">True</SelectItem>
						<SelectItem value="false">False</SelectItem>
					</SelectContent>
				</Select>
				{property.description ? (
					<p className="text-muted-foreground text-xs">
						{property.description}
					</p>
				) : null}
			</div>
		);
	}
	if (type === "object" || type === "array") {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Textarea
					id={`composio-${name}`}
					onChange={(event) => onChange(event.target.value)}
					placeholder={type === "array" ? "[]" : "{}"}
					required={required}
					rows={3}
					value={value}
				/>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`composio-${name}`}>{label}</Label>
			<Input
				id={`composio-${name}`}
				onChange={(event) => onChange(event.target.value)}
				placeholder={property.description}
				required={required}
				type={type === "number" || type === "integer" ? "number" : "text"}
				value={value}
			/>
		</div>
	);
}
