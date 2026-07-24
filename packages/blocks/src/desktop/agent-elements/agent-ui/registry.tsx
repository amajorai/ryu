// Registry: maps every component in ./catalog.ts to a real `@ryu/ui` (Base UI)
// component, so agent-rendered UI uses the exact same primitives — and therefore
// the same theme tokens, focus behavior and accessibility — as the rest of the app.
//
// Interactive fields use json-render's `useBoundProp(props.x, bindings?.x)` to get
// a [value, setValue] pair wired to the spec's `{ $bindState: "path" }` bindings.

import {
	type BaseComponentProps,
	type Components,
	defineRegistry,
	useBoundProp,
} from "@json-render/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { agentUiCatalog } from "./catalog.ts";

const GAP_CLASS: Record<string, string> = {
	none: "gap-0",
	xs: "gap-1",
	sm: "gap-2",
	md: "gap-3",
	lg: "gap-4",
	xl: "gap-6",
};

const ALIGN_CLASS: Record<string, string> = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	stretch: "items-stretch",
};

const JUSTIFY_CLASS: Record<string, string> = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	between: "justify-between",
	around: "justify-around",
};

const TEXT_SIZE_CLASS: Record<string, string> = {
	xs: "text-xs",
	sm: "text-sm",
	base: "text-sm",
	lg: "text-base",
};

const TEXT_WEIGHT_CLASS: Record<string, string> = {
	normal: "font-normal",
	medium: "font-medium",
	semibold: "font-semibold",
	bold: "font-bold",
};

const HEADING_CLASS: Record<number, string> = {
	1: "text-xl font-semibold",
	2: "text-lg font-semibold",
	3: "text-base font-semibold",
	4: "text-sm font-medium",
};

// Convenience alias so each renderer reads cleanly.
type Render<P> = (ctx: BaseComponentProps<P>) => ReactNode;

// Agent-controlled UI: the spec (including href/src) is supplied by the model, so
// any URL must be scheme-checked before it reaches the DOM. A `javascript:` href on
// an <a> is directly clickable XSS; resolve against the app origin and only allow an
// explicit allowlist, otherwise fall back to an inert "#".
const sanitizeUrl = (
	raw: string | undefined,
	allowed: readonly string[]
): string => {
	if (!raw) {
		return "#";
	}
	try {
		const origin =
			typeof window === "undefined"
				? "http://localhost"
				: window.location.origin;
		const url = new URL(raw, origin);
		return allowed.includes(url.protocol) ? url.toString() : "#";
	} catch {
		return "#";
	}
};

const LINK_SCHEMES = ["http:", "https:", "mailto:"] as const;
const IMAGE_SCHEMES = ["http:", "https:", "data:", "blob:"] as const;

const StackRenderer: Render<{
	direction?: "row" | "column";
	gap?: keyof typeof GAP_CLASS;
	align?: keyof typeof ALIGN_CLASS;
	justify?: keyof typeof JUSTIFY_CLASS;
	wrap?: boolean;
}> = ({ props, children }) => (
	<div
		className={cn(
			"flex",
			props.direction === "row" ? "flex-row" : "flex-col",
			GAP_CLASS[props.gap ?? "md"],
			props.align && ALIGN_CLASS[props.align],
			props.justify && JUSTIFY_CLASS[props.justify],
			props.wrap && "flex-wrap"
		)}
	>
		{children}
	</div>
);

const GridRenderer: Render<{
	columns?: number;
	gap?: keyof typeof GAP_CLASS;
}> = ({ props, children }) => (
	<div
		className={cn("grid", GAP_CLASS[props.gap ?? "md"])}
		style={{
			gridTemplateColumns: `repeat(${props.columns ?? 2}, minmax(0, 1fr))`,
		}}
	>
		{children}
	</div>
);

const CardRenderer: Render<{ title?: string; description?: string }> = ({
	props,
	children,
}) => (
	<Card>
		{(props.title || props.description) && (
			<CardHeader>
				{props.title && <CardTitle>{props.title}</CardTitle>}
				{props.description && (
					<CardDescription>{props.description}</CardDescription>
				)}
			</CardHeader>
		)}
		<CardContent>{children}</CardContent>
	</Card>
);

const SeparatorRenderer: Render<{
	orientation?: "horizontal" | "vertical";
}> = ({ props }) => (
	<Separator orientation={props.orientation ?? "horizontal"} />
);

const HeadingRenderer: Render<{ text: string; level?: number }> = ({
	props,
}) => {
	const level = props.level ?? 2;
	const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
	return (
		<Tag className={HEADING_CLASS[level] ?? HEADING_CLASS[2]}>{props.text}</Tag>
	);
};

const TextRenderer: Render<{
	text: string;
	muted?: boolean;
	size?: keyof typeof TEXT_SIZE_CLASS;
	weight?: keyof typeof TEXT_WEIGHT_CLASS;
}> = ({ props }) => (
	<p
		className={cn(
			"leading-relaxed",
			TEXT_SIZE_CLASS[props.size ?? "sm"],
			props.weight && TEXT_WEIGHT_CLASS[props.weight],
			props.muted ? "text-muted-foreground" : "text-foreground/90"
		)}
	>
		{props.text}
	</p>
);

const LinkRenderer: Render<{ text: string; href: string }> = ({ props }) => (
	<a
		className="text-primary text-sm underline-offset-2 hover:underline"
		href={sanitizeUrl(props.href, LINK_SCHEMES)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{props.text}
	</a>
);

const ImageRenderer: Render<{
	src: string;
	alt?: string;
	rounded?: boolean;
}> = ({ props }) => (
	// biome-ignore lint/performance/noImgElement: agent-rendered content, not a Next.js route
	// biome-ignore lint/correctness/useImageSize: agent-supplied images have no known dimensions
	<img
		alt={props.alt ?? ""}
		className={cn("max-w-full", props.rounded && "rounded-lg")}
		src={sanitizeUrl(props.src, IMAGE_SCHEMES)}
	/>
);

const AvatarRenderer: Render<{
	src?: string;
	alt?: string;
	fallback?: string;
}> = ({ props }) => (
	<Avatar>
		{props.src && (
			<AvatarImage
				alt={props.alt ?? ""}
				src={sanitizeUrl(props.src, IMAGE_SCHEMES)}
			/>
		)}
		<AvatarFallback>{props.fallback ?? "?"}</AvatarFallback>
	</Avatar>
);

const BadgeRenderer: Render<{
	text: string;
	variant?: "default" | "secondary" | "outline" | "destructive";
}> = ({ props }) => (
	<Badge variant={props.variant ?? "default"}>{props.text}</Badge>
);

const AlertRenderer: Render<{
	title?: string;
	description?: string;
	variant?: "default" | "destructive";
}> = ({ props, children }) => (
	<Alert variant={props.variant ?? "default"}>
		{props.title && <AlertTitle>{props.title}</AlertTitle>}
		{props.description && (
			<AlertDescription>{props.description}</AlertDescription>
		)}
		{children}
	</Alert>
);

const TableRenderer: Render<{ columns: string[]; rows: string[][] }> = ({
	props,
}) => (
	<div className="overflow-x-auto rounded-[var(--radius)] border border-border">
		<Table>
			<TableHeader>
				<TableRow>
					{props.columns.map((col) => (
						<TableHead key={col}>{col}</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((row) => {
					const rowKey = row.join("");
					return (
						<TableRow key={rowKey}>
							{row.map((cell, cellIndex) => (
								<TableCell
									key={`${rowKey}:${props.columns[cellIndex] ?? cellIndex}`}
								>
									{cell}
								</TableCell>
							))}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	</div>
);

const ProgressRenderer: Render<{ value: number; label?: string }> = ({
	props,
}) => (
	<div className="flex flex-col gap-1.5">
		{props.label && (
			<span className="text-muted-foreground text-xs">{props.label}</span>
		)}
		<Progress value={props.value} />
	</div>
);

const SkeletonRenderer: Render<{ width?: string; height?: string }> = ({
	props,
}) => (
	<Skeleton
		style={{ width: props.width ?? "100%", height: props.height ?? "1rem" }}
	/>
);

const ButtonRenderer: Render<{
	label: string;
	variant?:
		| "default"
		| "secondary"
		| "outline"
		| "ghost"
		| "destructive"
		| "link";
	size?: "sm" | "default" | "lg";
	disabled?: boolean;
}> = ({ props, emit }) => (
	<Button
		disabled={props.disabled}
		onClick={() => emit("press")}
		size={props.size ?? "default"}
		variant={props.variant ?? "default"}
	>
		{props.label}
	</Button>
);

const InputRenderer: Render<{
	placeholder?: string;
	value?: string;
	label?: string;
	type?: "text" | "email" | "password" | "number";
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	return (
		<div className="flex flex-col gap-1.5">
			{props.label && <Label>{props.label}</Label>}
			<Input
				onChange={(event) => setValue(event.target.value)}
				placeholder={props.placeholder}
				type={props.type ?? "text"}
				value={value ?? ""}
			/>
		</div>
	);
};

const TextareaRenderer: Render<{
	placeholder?: string;
	value?: string;
	label?: string;
	rows?: number;
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	return (
		<div className="flex flex-col gap-1.5">
			{props.label && <Label>{props.label}</Label>}
			<Textarea
				onChange={(event) => setValue(event.target.value)}
				placeholder={props.placeholder}
				rows={props.rows}
				value={value ?? ""}
			/>
		</div>
	);
};

const CheckboxRenderer: Render<{ label?: string; checked?: boolean }> = ({
	props,
	bindings,
}) => {
	const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);
	return (
		<Label className="flex items-center gap-2">
			<Checkbox
				checked={checked ?? false}
				onCheckedChange={(next) => setChecked(Boolean(next))}
			/>
			{props.label && <span className="text-sm">{props.label}</span>}
		</Label>
	);
};

const SwitchRenderer: Render<{ label?: string; checked?: boolean }> = ({
	props,
	bindings,
}) => {
	const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);
	return (
		<Label className="flex items-center gap-2">
			<Switch
				checked={checked ?? false}
				onCheckedChange={(next) => setChecked(Boolean(next))}
			/>
			{props.label && <span className="text-sm">{props.label}</span>}
		</Label>
	);
};

const SelectRenderer: Render<{
	placeholder?: string;
	value?: string;
	options: { label: string; value: string }[];
}> = ({ props, bindings }) => {
	const [value, setValue] = useBoundProp(props.value, bindings?.value);
	const options = props.options ?? [];
	return (
		<Select
			items={options}
			onValueChange={(next) => setValue(next ?? "")}
			value={value ?? ""}
		>
			<SelectTrigger className="w-full">
				<SelectValue placeholder={props.placeholder} />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};

const components = {
	Stack: StackRenderer,
	Grid: GridRenderer,
	Card: CardRenderer,
	Separator: SeparatorRenderer,
	Heading: HeadingRenderer,
	Text: TextRenderer,
	Link: LinkRenderer,
	Image: ImageRenderer,
	Avatar: AvatarRenderer,
	Badge: BadgeRenderer,
	Alert: AlertRenderer,
	Table: TableRenderer,
	Progress: ProgressRenderer,
	Skeleton: SkeletonRenderer,
	Button: ButtonRenderer,
	Input: InputRenderer,
	Textarea: TextareaRenderer,
	Checkbox: CheckboxRenderer,
	Switch: SwitchRenderer,
	Select: SelectRenderer,
} as unknown as Components<typeof agentUiCatalog>;

export const { registry } = defineRegistry(agentUiCatalog, { components });
