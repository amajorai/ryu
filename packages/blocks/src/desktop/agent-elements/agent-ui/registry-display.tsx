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
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { createElement } from "react";
import {
	type AgentUiGeometryStyle,
	ALIGN_CLASS,
	GAP_CLASS,
	HEADING_CLASS,
	IMAGE_SCHEMES,
	JUSTIFY_CLASS,
	LINK_SCHEMES,
	type Render,
	sanitizeUrl,
	TEXT_SIZE_CLASS,
	TEXT_WEIGHT_CLASS,
} from "./registry-shared.ts";

export const StackRenderer: Render<{
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

export const GridRenderer: Render<{
	columns?: number;
	gap?: keyof typeof GAP_CLASS;
}> = ({ props, children }) => {
	const geometry: AgentUiGeometryStyle = {
		"--agent-ui-columns": `repeat(${props.columns ?? 2}, minmax(0, 1fr))`,
	};
	return (
		<div
			className={cn(
				"grid",
				GAP_CLASS[props.gap ?? "md"],
				"grid-cols-(--agent-ui-columns)"
			)}
			style={geometry}
		>
			{children}
		</div>
	);
};

export const CardRenderer: Render<{ title?: string; description?: string }> = ({
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

export const SeparatorRenderer: Render<{
	orientation?: "horizontal" | "vertical";
}> = ({ props }) => (
	<Separator orientation={props.orientation ?? "horizontal"} />
);

export const HeadingRenderer: Render<{ text: string; level?: number }> = ({
	props,
}) => {
	const level = props.level ?? 2;
	return createElement(
		`h${level}`,
		{ className: HEADING_CLASS[level] ?? HEADING_CLASS[2] },
		props.text
	);
};

export const TextRenderer: Render<{
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
			props.muted ? "text-muted-foreground" : "text-foreground"
		)}
	>
		{props.text}
	</p>
);

export const LinkRenderer: Render<{ text: string; href: string }> = ({
	props,
}) => (
	<a
		className="text-primary text-sm underline-offset-2 hover:underline"
		href={sanitizeUrl(props.href, LINK_SCHEMES)}
		rel="noopener noreferrer"
		target="_blank"
	>
		{props.text}
	</a>
);

export const ImageRenderer: Render<{
	src: string;
	alt?: string;
	rounded?: boolean;
}> = ({ props }) => (
	<img
		alt={props.alt ?? ""}
		className={cn("max-w-full", props.rounded && "rounded-lg")}
		src={sanitizeUrl(props.src, IMAGE_SCHEMES)}
	/>
);

export const AvatarRenderer: Render<{
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

export const BadgeRenderer: Render<{
	text: string;
	variant?: "default" | "secondary" | "outline" | "destructive";
}> = ({ props }) => (
	<Badge variant={props.variant ?? "default"}>{props.text}</Badge>
);

export const AlertRenderer: Render<{
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

export const TableRenderer: Render<{ columns: string[]; rows: string[][] }> = ({
	props,
}) => (
	<div className="overflow-x-auto rounded-lg border border-border">
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
					const rowKey = row.join("\u0001");
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
