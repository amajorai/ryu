"use client";

import {
	Alert02Icon,
	ComputerTerminal01Icon,
	FolderOpenIcon,
	Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import styles from "./full-access-warning.module.css";

export interface FullAccessSelectionItem {
	description?: string | null;
	id: string;
	name: string;
}

/**
 * ACP agents choose their own ids and labels for the most permissive mode.
 * Keep this classifier deliberately focused on unrestricted/approval-bypassing
 * language so ordinary edit, auto, plan, and read-only modes stay frictionless.
 */
export function isFullAccessEquivalent(
	item: FullAccessSelectionItem,
	sectionLabel = ""
): boolean {
	const value = `${item.id} ${item.name}`
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replaceAll("_", "-");
	const section = sectionLabel
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replaceAll("_", "-");

	if (
		/(?:^|[^a-z])full[-\s]*access(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])bypass(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])bypass[-\s]*(?:permissions?|approval|safety|sandbox)(?:$|[^a-z])/.test(
			value
		) ||
		/(?:^|[^a-z])danger(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])danger(?:ous)?[-\s]*full[-\s]*access(?:$|[^a-z])/.test(
			value
		) ||
		/(?:^|[^a-z])yolo(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])unrestricted(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])skip(?:$|[^a-z])/.test(value) ||
		/(?:^|[^a-z])(?:no|without|skip)[-\s]*(?:approval|permission|prompt|confirmation)(?:s)?(?:$|[^a-z])/.test(
			value
		) ||
		/(?:^|[^a-z])(?:always[-\s]*(?:allow|approve)|allow[-\s]*all)(?:$|[^a-z])/.test(
			value
		)
	) {
		return true;
	}

	// Some agents expose approval policy and sandbox scope as separate options.
	// A literal `never`/`none` is only full-access-equivalent when the option is
	// itself an access/approval control; never treat an unrelated option that
	// happens to contain that value as dangerous.
	return (
		[/^never$/i, /^none$/i, /^off$/i].some((pattern) =>
			[item.id, item.name].some((candidate) => pattern.test(candidate.trim()))
		) && /(?:approval|permission|access|sandbox)/.test(section)
	);
}

interface FullAccessSelectionGuard {
	request: (
		item: FullAccessSelectionItem,
		apply: () => void,
		sectionLabel?: string
	) => void;
}

const FullAccessSelectionContext =
	createContext<FullAccessSelectionGuard | null>(null);

export function useFullAccessSelectionGuard(): FullAccessSelectionGuard | null {
	return useContext(FullAccessSelectionContext);
}

interface PendingFullAccessSelection {
	apply: () => void;
	item: FullAccessSelectionItem;
}

export interface FullAccessSelectionProviderProps {
	agentName?: string | null;
	children: ReactNode;
}

/**
 * Own the confirmation state once around a picker tree. Nested ACP pickers can
 * request the same dialog without each dropdown inventing a slightly different
 * warning or applying a high-risk mode before the user confirms it.
 */
export function FullAccessSelectionProvider({
	agentName,
	children,
}: FullAccessSelectionProviderProps) {
	const [pending, setPending] = useState<PendingFullAccessSelection | null>(
		null
	);

	const request = useCallback<FullAccessSelectionGuard["request"]>(
		(item, apply, sectionLabel) => {
			if (!isFullAccessEquivalent(item, sectionLabel)) {
				apply();
				return;
			}
			setPending({ apply, item });
		},
		[]
	);

	const selection = useMemo(() => ({ request }), [request]);
	const cancel = useCallback(() => setPending(null), []);
	const confirm = useCallback(() => {
		if (!pending) {
			return;
		}
		pending.apply();
		setPending(null);
	}, [pending]);

	return (
		<FullAccessSelectionContext.Provider value={selection}>
			{children}
			<FullAccessWarningDialog
				agentName={agentName}
				modeName={pending?.item.name}
				onConfirm={confirm}
				onOpenChange={(open) => {
					if (!open) {
						cancel();
					}
				}}
				open={pending !== null}
			/>
		</FullAccessSelectionContext.Provider>
	);
}

export interface FullAccessWarningDialogProps {
	agentName?: string | null;
	modeName?: string;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

const CAPABILITIES = [
	{
		description:
			"Read, create, modify, upload, or delete files anywhere on this computer",
		icon: FolderOpenIcon,
		title: "Files and folders",
	},
	{
		description: "Run commands, install software, and change system settings",
		icon: ComputerTerminal01Icon,
		title: "Terminal commands",
	},
	{
		description: "Access websites, send data, and use enabled plugins",
		icon: Globe02Icon,
		title: "Internet and connected apps",
	},
] as const;

export function FullAccessWarningDialog({
	agentName,
	modeName,
	onConfirm,
	onOpenChange,
	open,
}: FullAccessWarningDialogProps) {
	const tl = useLiteralMessages();
	const subject = agentName?.trim() || tl("This ACP agent");

	return (
		<AlertDialog onOpenChange={onOpenChange} open={open}>
			<AlertDialogContent
				className="sm:max-w-[520px]"
				render={<div className={styles.content} />}
				size="default"
			>
				<div
					className={cn(
						"grid grid-rows-[auto_1fr] place-items-center text-center sm:place-items-start sm:text-start",
						styles.header
					)}
					data-slot="alert-dialog-header"
				>
					<AlertDialogTitle
						className="flex items-center"
						render={(props) => (
							<h2 {...props} className={cn(props.className, styles.title)}>
								{props.children}
							</h2>
						)}
					>
						<HugeiconsIcon
							className="size-4 text-status-warning"
							icon={Alert02Icon}
							strokeWidth={2}
						/>
						<span>Turn on Full Access?</span>
					</AlertDialogTitle>
					<AlertDialogDescription
						className="text-left"
						render={<p className={styles.description} />}
					>
						{tl(
							"{subject} will be able to run commands, use the internet, and create and edit files anywhere on this computer without your permission. This includes but is not limited to:",
							{ subject }
						)}
					</AlertDialogDescription>
				</div>

				<div className="overflow-hidden rounded-2xl bg-muted/70 px-4">
					{CAPABILITIES.map(({ description, icon, title }) => (
						<div className="flex items-start gap-3 py-3.5" key={title}>
							<HugeiconsIcon
								className="mt-0.5 size-5 shrink-0 text-primary"
								icon={icon}
								strokeWidth={2}
							/>
							<div className="min-w-0">
								<p className="font-medium text-sm">{title}</p>
								<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
									{description}
								</p>
							</div>
						</div>
					))}
				</div>

				<AlertDialogDescription
					className="text-left"
					render={<p className={styles.description} />}
				>
					This comes with risks like loss or exposure of sensitive data and
					prompt injection. You can turn this off.{" "}
					<a
						href="https://docs.ryuhq.com/docs/extend/integrate/acp-integration#permission-system"
						rel="noopener"
						target="_blank"
					>
						Learn more
					</a>
				</AlertDialogDescription>

				<AlertDialogFooter className="mt-1 sm:items-center">
					<AlertDialogCancel variant="secondary">Cancel</AlertDialogCancel>
					<AlertDialogAction
						aria-label={
							modeName
								? tl("Confirm {modeName} full access", { modeName })
								: "Confirm full access"
						}
						onClick={onConfirm}
						variant="destructive"
					>
						<HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={2} />
						Confirm
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
