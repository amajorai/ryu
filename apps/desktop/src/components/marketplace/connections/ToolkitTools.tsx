import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	useComposioActions,
	useComposioTriggers,
} from "@/src/hooks/useComposioCatalog.ts";

export function ToolkitTools({ toolkit }: { toolkit: string }) {
	const actions = useComposioActions(toolkit);
	const triggers = useComposioTriggers(toolkit);

	return (
		<div className="mt-3 space-y-3 border-t pt-3">
			<ToolSection
				emptyLabel="No tools listed for this integration."
				error={actions.error}
				items={(actions.data ?? []).map((a) => ({
					id: a.name,
					label: a.displayName,
					description: a.description,
				}))}
				loading={actions.isLoading}
				title="Tools"
			/>
			{triggers.data && triggers.data.length > 0 ? (
				<ToolSection
					emptyLabel="No triggers for this integration."
					error={triggers.error}
					items={triggers.data.map((t) => ({
						id: t.name,
						label: t.displayName,
						description: t.description,
					}))}
					loading={triggers.isLoading}
					title="Triggers"
				/>
			) : null}
		</div>
	);
}

export interface ToolSectionItem {
	description: string | null;
	id: string;
	label: string;
}

/** Renders one labelled list (Tools or Triggers); body via early returns. */
export function ToolSectionBody({
	items,
	loading,
	error,
	emptyLabel,
}: {
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	if (loading) {
		return <SkeletonRows />;
	}
	if (error) {
		return <p className="text-status-destructive text-xs">{error.message}</p>;
	}
	if (items.length === 0) {
		return <p className="text-muted-foreground text-xs">{emptyLabel}</p>;
	}
	return (
		<ul className="scroll-fade max-h-48 space-y-1 overflow-auto">
			{items.map((item) => (
				<li
					className="rounded-lg px-2 py-1 text-xs hover:bg-muted/50"
					key={item.id}
				>
					<span className="font-medium">{item.label}</span>
					{item.description ? (
						<span
							className="block truncate text-muted-foreground"
							title={item.description}
						>
							{item.description}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

export function ToolSection({
	title,
	items,
	loading,
	error,
	emptyLabel,
}: {
	title: string;
	items: ToolSectionItem[];
	loading: boolean;
	error: Error | null;
	emptyLabel: string;
}) {
	return (
		<div>
			<p className="mb-1.5 text-detail text-muted-foreground">{title}</p>
			<ToolSectionBody
				emptyLabel={emptyLabel}
				error={error}
				items={items}
				loading={loading}
			/>
		</div>
	);
}
