import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import type { OpenRouterProvider } from "@/src/lib/api/openrouter.ts";
import {
	PROVIDER_LIST_ID,
	providerName,
} from "./NodeRoutingSettings-options.ts";

function OpenRouterProviderPicker({
	onChange,
	placeholder,
	buttonLabel,
	locked,
}: {
	onChange: (slug: string) => void;
	placeholder: string;
	buttonLabel: string;
	locked?: boolean;
}) {
	const [candidate, setCandidate] = useState("");
	const add = () => {
		const slug = candidate.trim().toLowerCase();
		if (!slug) {
			return;
		}
		onChange(slug);
		setCandidate("");
	};

	return (
		<div className="flex min-w-0 gap-2">
			<Input
				aria-label="OpenRouter provider slug"
				autoComplete="off"
				className="min-w-0"
				disabled={locked}
				list={PROVIDER_LIST_ID}
				onChange={(event) => setCandidate(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						add();
					}
				}}
				placeholder={placeholder}
				value={candidate}
			/>
			<Button disabled={locked || !candidate.trim()} onClick={add} size="sm">
				{buttonLabel}
			</Button>
		</div>
	);
}

export function ProviderListEditor({
	label,
	providers,
	values,
	onChange,
	disabled,
}: {
	label: string;
	providers: OpenRouterProvider[];
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const tl = useLiteralMessages();
	const add = (slug: string) => {
		if (!values.includes(slug)) {
			onChange([...values, slug]);
		}
	};
	return (
		<div className="space-y-2">
			<p className="text-sm">{label}</p>
			<OpenRouterProviderPicker
				buttonLabel="Add"
				locked={disabled}
				onChange={add}
				placeholder="Search providers or enter a slug"
			/>
			{values.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{values.map((slug) => (
						<span
							className="inline-flex items-center gap-2 rounded-full bg-muted py-0.5 pr-0.5 pl-3 text-xs"
							key={slug}
						>
							<span>{providerName(providers, slug)}</span>
							<code className="text-muted-foreground">{slug}</code>
							<Button
								aria-label={tl("Remove {slug}", { slug })}
								disabled={disabled}
								onClick={() => onChange(values.filter((item) => item !== slug))}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

export function OrderedProviderEditor({
	providers,
	values,
	onChange,
	disabled,
}: {
	providers: OpenRouterProvider[];
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const tl = useLiteralMessages();
	const add = (slug: string) => {
		if (!values.includes(slug)) {
			onChange([...values, slug]);
		}
	};
	const move = (index: number, direction: -1 | 1) => {
		const nextIndex = index + direction;
		if (nextIndex < 0 || nextIndex >= values.length) {
			return;
		}
		const next = [...values];
		[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
		onChange(next);
	};

	return (
		<div className="space-y-3">
			<OpenRouterProviderPicker
				buttonLabel="Add provider"
				locked={disabled}
				onChange={add}
				placeholder="Search providers or enter a slug"
			/>
			{values.length > 0 ? (
				<ol className="divide-y divide-border/60">
					{values.map((slug, index) => (
						<li
							className="flex flex-wrap items-center justify-between gap-2 py-1.5"
							key={`${slug}-${index}`}
						>
							<span className="min-w-0">
								<span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs">
									{index + 1}
								</span>
								<span className="font-medium text-sm">
									{providerName(providers, slug)}
								</span>
								<code className="ml-2 text-muted-foreground text-xs">
									{slug}
								</code>
							</span>
							<span className="flex gap-1">
								<Button
									aria-label={tl("Move {slug} up", { slug })}
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									size="sm"
									variant="ghost"
								>
									Move up
								</Button>
								<Button
									aria-label={tl("Move {slug} down", { slug })}
									disabled={disabled || index === values.length - 1}
									onClick={() => move(index, 1)}
									size="sm"
									variant="ghost"
								>
									Move down
								</Button>
								<Button
									aria-label={tl("Remove {slug}", { slug })}
									disabled={disabled}
									onClick={() =>
										onChange(values.filter((item) => item !== slug))
									}
									size="sm"
									variant="ghost"
								>
									Remove
								</Button>
							</span>
						</li>
					))}
				</ol>
			) : (
				<p className="text-muted-foreground text-xs">
					No order is set. OpenRouter can choose the healthiest matching
					provider.
				</p>
			)}
		</div>
	);
}
