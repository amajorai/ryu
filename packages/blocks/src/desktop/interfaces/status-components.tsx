import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	COMPONENT_STATE_LABELS,
	type ComponentState,
	type StatusComponent,
	type StatusSection,
	UPTIME_BASIS,
	UPTIME_DAYS,
} from "./status-model.ts";
import { StatusUptime } from "./status-uptime.tsx";

export const STATE_TEXT: Record<ComponentState, string> = {
	degraded: "text-status-warning",
	operational: "text-status-success",
	working: "text-status-info",
};

const EASE = [0.22, 1, 0.36, 1] as const;

function StateLabel({ state }: { state: ComponentState }) {
	return (
		<span
			className={cn("shrink-0 font-medium text-sm", STATE_TEXT[state])}
			data-state={state}
		>
			{COMPONENT_STATE_LABELS[state]}
		</span>
	);
}

function ComponentRow({
	component,
	nested,
}: {
	component: StatusComponent;
	nested: boolean;
}) {
	return (
		<li
			className={cn(
				"flex flex-col gap-3 py-4 pe-5 max-sm:pe-4",
				nested ? "ps-11 max-sm:ps-10" : "ps-5 max-sm:ps-4"
			)}
			data-agent-id={component.agent.id}
			data-testid="status-component"
		>
			<div className="flex min-w-0 items-baseline justify-between gap-4">
				<h3
					className="min-w-0 truncate font-medium text-foreground text-sm"
					title={component.agent.description || undefined}
				>
					{component.agent.name}
				</h3>
				<StateLabel state={component.state} />
			</div>
			<StatusUptime component={component} />
		</li>
	);
}

function GroupBlock({
	collapsed,
	onToggle,
	section,
}: {
	collapsed: boolean;
	onToggle: () => void;
	section: StatusSection & { group: NonNullable<StatusSection["group"]> };
}) {
	const reduceMotion = useReducedMotion();
	const contentId = useId();
	const count = section.components.length;
	return (
		<li data-testid="status-group">
			<h3>
				<button
					aria-controls={contentId}
					aria-expanded={!collapsed}
					className="flex w-full items-center gap-2 py-4 ps-5 pe-5 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:ps-4 max-sm:pe-4"
					onClick={onToggle}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
							!collapsed && "rotate-90"
						)}
					/>
					<span className="min-w-0 truncate font-medium text-foreground text-sm">
						{section.group.name}
					</span>
					<span className="shrink-0 text-muted-foreground text-sm">
						{count} {count === 1 ? "agent" : "agents"}
					</span>
					<span className="ms-auto" />
					<StateLabel state={section.state} />
				</button>
			</h3>
			<AnimatePresence initial={false}>
				{collapsed ? null : (
					<motion.div
						animate={{ height: "auto", opacity: 1 }}
						className="overflow-hidden"
						exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
						id={contentId}
						initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
						transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE }}
					>
						<ul className="divide-y divide-border border-border border-t">
							{section.components.map((component) => (
								<ComponentRow
									component={component}
									key={component.agent.id}
									nested
								/>
							))}
						</ul>
					</motion.div>
				)}
			</AnimatePresence>
		</li>
	);
}

/**
 * Every agent as a status-page component, team groups first (collapsible),
 * then agents outside any team, in one ruled box under a quiet caption.
 */
export function StatusComponents({
	collapsed,
	onToggle,
	sections,
}: {
	collapsed: ReadonlySet<string>;
	onToggle: (groupId: string) => void;
	sections: readonly StatusSection[];
}) {
	const tl = useLiteralMessages();
	return (
		<section aria-labelledby="status-components-heading">
			<div className="mb-3 flex items-baseline justify-between gap-4">
				<h2
					className="text-base text-foreground leading-6"
					id="status-components-heading"
				>
					<span className="font-semibold">Agents</span>
				</h2>
				<p className="text-muted-foreground text-xs">
					{tl("Uptime over the past {uptimeDays} days", {
						uptimeDays: UPTIME_DAYS,
					})}
				</p>
			</div>
			<ul className="divide-y divide-border rounded-md border border-border bg-card">
				{sections.flatMap((section) => {
					const { group } = section;
					if (group) {
						return [
							<GroupBlock
								collapsed={collapsed.has(group.id)}
								key={group.id}
								onToggle={() => onToggle(group.id)}
								section={{ ...section, group }}
							/>,
						];
					}
					return section.components.map((component) => (
						<ComponentRow
							component={component}
							key={component.agent.id}
							nested={false}
						/>
					));
				})}
			</ul>
			<p className="mt-2 text-muted-foreground text-xs">{UPTIME_BASIS}</p>
		</section>
	);
}
