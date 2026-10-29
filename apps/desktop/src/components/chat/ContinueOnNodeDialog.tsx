import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	createRnpContextBundle,
	normalizeRnpNodeUrl,
	parseRnpContinuityBundle,
	RNP_WORKSPACE_LIMITS,
	type RnpContinuityBundleV0,
	type RnpResumeResultV0,
	type RnpWorkspaceDestinationV0,
	type RnpWorkspaceInspectionV0,
	type RnpWorkspaceManifestV0,
	type RnpWorkspaceResumeResultV0,
} from "@ryuhq/protocol/continuity";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useEffect, useMemo, useState } from "react";
import {
	ContinueOnNodeWorkspace,
	defaultUntrackedSelection,
	selectedUntrackedBytes,
} from "@/src/components/chat/ContinueOnNodeWorkspace.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	exportRnpConversation,
	resumeRnpConversation,
} from "@/src/lib/api/continuity.ts";
import {
	continueRnpWorkspace,
	exportRnpWorkspace,
	inspectRnpWorkspace,
	markRnpContinued,
	probeRnpCapabilities,
	type WorkspaceRelayProgress,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

/**
 * v1 resumes into a new clone only. A worktree added to an existing, trusted
 * checkout would inherit that checkout's workspace trust, so the destination
 * refuses existing-checkout mode until handed-off worktrees are excluded.
 */
const NEW_CLONE_DESTINATION: RnpWorkspaceDestinationV0 = { mode: "new-clone" };

/** The working-tree half of a frozen handoff: resent unchanged on retry. */
interface AttemptedWorkspace {
	destination: RnpWorkspaceDestinationV0;
	manifest: RnpWorkspaceManifestV0;
}

export interface ContinueOnNodeDialogProps {
	conversationId: string;
	conversationTitle: string;
	nodes: readonly Node[];
	onCompleted: (
		node: Node,
		result: RnpResumeResultV0,
		workspace?: RnpWorkspaceResumeResultV0
	) => Promise<void> | void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	resolveNodes?: () => readonly Node[];
	sourceNode: Node;
	sourceUpdatedAt?: number;
}

function errorMessage<TError>(error: TError): string {
	return error instanceof Error
		? error.message
		: "The handoff could not finish.";
}

function sameNode(left: Node, right: Node): boolean {
	return normalizeRnpNodeUrl(left.url) === normalizeRnpNodeUrl(right.url);
}

function currentNode(
	reference: Node,
	nodes: readonly Node[]
): Node | undefined {
	return nodes.find((node) => sameNode(node, reference));
}

function buildResumeBundle(
	preview: RnpContinuityBundleV0,
	contextNote: string,
	includeAgentHint: boolean
): RnpContinuityBundleV0 {
	const context = contextNote
		? createRnpContextBundle({
				items: [
					{
						id: "operator-note",
						kind: "text",
						label: "Operator note",
						mediaType: "text/plain",
						text: contextNote,
						source: { kind: "manual" },
					},
				],
			})
		: { version: 0 as const, items: [] };
	const source = includeAgentHint
		? preview.source
		: {
				conversationId: preview.source.conversationId,
				updatedAt: preview.source.updatedAt,
				...(preview.source.checkpointMessageId
					? { checkpointMessageId: preview.source.checkpointMessageId }
					: undefined),
				...(preview.source.title ? { title: preview.source.title } : undefined),
			};
	const parsed = parseRnpContinuityBundle({ ...preview, source, context });
	if (!parsed.ok) {
		throw new Error(`The reviewed handoff is invalid: ${parsed.error.message}`);
	}
	return parsed.value;
}

export function ContinueOnNodeDialog({
	conversationId,
	conversationTitle,
	nodes,
	onCompleted,
	onOpenChange,
	open,
	resolveNodes,
	sourceNode,
	sourceUpdatedAt,
}: ContinueOnNodeDialogProps) {
	const destinations = useMemo(
		() => nodes.filter((node) => !sameNode(node, sourceNode)),
		[nodes, sourceNode]
	);
	const [selectedName, setSelectedName] = useState("");
	const [contextNote, setContextNote] = useState("");
	const [includeAgentHint, setIncludeAgentHint] = useState(false);
	const [preview, setPreview] = useState<RnpContinuityBundleV0 | null>(null);
	const [attemptedBundle, setAttemptedBundle] =
		useState<RnpContinuityBundleV0 | null>(null);
	const [previewPending, setPreviewPending] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [inspection, setInspection] = useState<RnpWorkspaceInspectionV0 | null>(
		null
	);
	const [workspaceSupported, setWorkspaceSupported] = useState(false);
	const [workspaceEnabled, setWorkspaceEnabled] = useState(true);
	const [selectedUntracked, setSelectedUntracked] = useState<Set<string>>(
		() => new Set()
	);
	const [attemptedWorkspace, setAttemptedWorkspace] =
		useState<AttemptedWorkspace | null>(null);
	const [relayProgress, setRelayProgress] =
		useState<WorkspaceRelayProgress | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedName((current) =>
			destinations.some((node) => node.name === current)
				? current
				: (destinations[0]?.name ?? "")
		);
	}, [destinations, open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setPreview(null);
		setAttemptedBundle(null);
		setContextNote("");
		setIncludeAgentHint(false);
		setError(null);
		setCopied(false);
		setPreviewPending(true);
		setInspection(null);
		setWorkspaceEnabled(true);
		setSelectedUntracked(new Set());
		setAttemptedWorkspace(null);
		setRelayProgress(null);

		const availableNodes = resolveNodes?.() ?? nodes;
		const currentSource = currentNode(sourceNode, availableNodes);
		if (!currentSource) {
			setError("The source node is no longer configured.");
			setPreviewPending(false);
			return;
		}
		// The working tree is optional: an older source, a thread without a git
		// folder or a running turn simply hides the section.
		inspectRnpWorkspace(toTarget(currentSource), conversationId)
			.then((inspected) => {
				if (!cancelled) {
					setInspection(inspected);
					setSelectedUntracked(defaultUntrackedSelection(inspected));
				}
			})
			.catch(() => undefined);
		void exportRnpConversation(toTarget(currentSource), conversationId, {
			version: 0,
			ifUpdatedAt: sourceUpdatedAt,
			transcript: { mode: "recent", maxMessages: 50 },
			includeAgentHint: true,
		})
			.then((bundle) => {
				if (!cancelled) {
					setPreview(bundle);
				}
			})
			.catch((cause) => {
				if (!cancelled) {
					setError(errorMessage(cause));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setPreviewPending(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [conversationId, nodes, open, resolveNodes, sourceNode, sourceUpdatedAt]);

	useEffect(() => {
		const destination = destinations.find((node) => node.name === selectedName);
		if (!(open && destination)) {
			setWorkspaceSupported(false);
			return;
		}
		let cancelled = false;
		setWorkspaceSupported(false);
		probeRnpCapabilities(toTarget(destination))
			.then((supported) => {
				if (!cancelled) {
					setWorkspaceSupported(supported);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [destinations, open, selectedName]);

	const locked = pending || attemptedBundle !== null;
	const workspaceAvailable = Boolean(inspection && workspaceSupported);
	const workspaceBlocked =
		workspaceAvailable &&
		workspaceEnabled &&
		attemptedWorkspace === null &&
		inspection !== null &&
		(selectedUntracked.size > RNP_WORKSPACE_LIMITS.untrackedCount ||
			selectedUntrackedBytes(inspection, selectedUntracked) >
				RNP_WORKSPACE_LIMITS.untrackedTotalBytes);
	const toggleUntracked = (path: string) => {
		setSelectedUntracked((current) => {
			const next = new Set(current);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	/** Export once, then reuse the same manifest and folder choice on retry. */
	const workspaceForAttempt = async (
		source: Node
	): Promise<AttemptedWorkspace | null> => {
		if (attemptedWorkspace) {
			return attemptedWorkspace;
		}
		if (!(workspaceAvailable && workspaceEnabled && inspection)) {
			return null;
		}
		const manifest = await exportRnpWorkspace(
			toTarget(source),
			conversationId,
			{
				version: 0,
				ifHead: inspection.repo.baseCommit,
				includeUntracked: [...selectedUntracked].sort(),
				...(sourceUpdatedAt === undefined
					? undefined
					: { ifUpdatedAt: sourceUpdatedAt }),
			}
		);
		const attempt = { manifest, destination: NEW_CLONE_DESTINATION };
		setAttemptedWorkspace(attempt);
		return attempt;
	};
	const handleContinue = async () => {
		if (!preview) {
			return;
		}
		const availableNodes = resolveNodes?.() ?? nodes;
		const currentSource = currentNode(sourceNode, availableNodes);
		const destination = availableNodes.find(
			(node) => node.name === selectedName && !sameNode(node, sourceNode)
		);
		if (!(currentSource && destination)) {
			setError("The source or destination node is no longer configured.");
			return;
		}
		setPending(true);
		setError(null);
		try {
			const bundle =
				attemptedBundle ??
				buildResumeBundle(preview, contextNote.trim(), includeAgentHint);
			if (!attemptedBundle) {
				setAttemptedBundle(bundle);
			}
			const workspace = await workspaceForAttempt(currentSource);
			// Transcript first (idempotent), then the working tree, then the
			// source marking, which only runs once the destination rebuilt the tree.
			const result = await resumeRnpConversation(toTarget(destination), bundle);
			let workspaceResult: RnpWorkspaceResumeResultV0 | undefined;
			if (workspace) {
				workspaceResult = await continueRnpWorkspace({
					conversationId,
					source: toTarget(currentSource),
					destination: toTarget(destination),
					manifest: workspace.manifest,
					destinationChoice: workspace.destination,
					nodeLabel: destination.name,
					bundleId: bundle.bundleId,
					onProgress: setRelayProgress,
				});
			} else {
				try {
					await markRnpContinued(toTarget(currentSource), conversationId, {
						nodeLabel: destination.name,
						bundleId: bundle.bundleId,
						at: Date.now(),
					});
				} catch {
					// An older source cannot record the marker; the transcript moved.
				}
			}
			await onCompleted(destination, result, workspaceResult);
			onOpenChange(false);
		} catch (cause) {
			setError(workspaceErrorMessage(cause, errorMessage(cause)));
		} finally {
			setPending(false);
		}
	};

	const handleCopyLink = async () => {
		setError(null);
		try {
			const link = buildRyuDeepLink({
				kind: "handoff",
				version: 0,
				conversationId,
				sourceNodeUrl: sourceNode.url,
			});
			await navigator.clipboard.writeText(link);
			setCopied(true);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	const reviewedTitle = preview?.source.title ?? conversationTitle;

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!(pending && !nextOpen)) {
					onOpenChange(nextOpen);
				}
			}}
			open={open}
		>
			<DialogContent appearance="continue-on-node">
				<DialogHeader>
					<DialogTitle>Continue on another node</DialogTitle>
					<DialogDescription>
						Review the exact visible transcript from {sourceNode.name} before
						copying it. Node credentials, structured authentication data, tool
						state, workspace paths, and the running agent session stay behind.
						Files move only when you bring the reviewed working tree.
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-2">
						<Label htmlFor="rnp-destination-node">Destination node</Label>
						<NativeSelect
							className="w-full"
							disabled={destinations.length === 0 || locked}
							id="rnp-destination-node"
							onChange={(event) => setSelectedName(event.target.value)}
							value={selectedName}
						>
							{destinations.length === 0 ? (
								<NativeSelectOption value="">
									No other configured node
								</NativeSelectOption>
							) : (
								destinations.map((node) => (
									<NativeSelectOption key={node.name} value={node.name}>
										{node.name}
									</NativeSelectOption>
								))
							)}
						</NativeSelect>
					</div>

					<div className="grid gap-2">
						<div className="flex items-center justify-between gap-3">
							<Label>Reviewed transcript</Label>
							<span className="text-muted-foreground text-xs">
								{preview ? `${preview.messages.length} messages` : "Loading…"}
							</span>
						</div>
						<div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border bg-muted/30 p-3">
							{previewPending ? (
								<p className="text-muted-foreground text-sm">
									Loading the reviewed snapshot…
								</p>
							) : (
								preview?.messages.map((message) => (
									<div className="text-sm" key={message.sourceId}>
										<p className="font-medium text-muted-foreground text-xs uppercase">
											{message.role}
										</p>
										<p className="whitespace-pre-wrap break-words">
											{message.text}
										</p>
									</div>
								))
							)}
						</div>
						<p className="text-muted-foreground text-xs">
							“{reviewedTitle}” from {sourceNode.name}
							{preview?.selection.omittedEarlierMessages
								? "; earlier messages are omitted"
								: "; no earlier visible messages are omitted"}
							. Visible messages can contain pasted secrets, so review them
							before continuing.
						</p>
					</div>

					{workspaceAvailable && inspection ? (
						<ContinueOnNodeWorkspace
							enabled={workspaceEnabled}
							inspection={inspection}
							locked={locked}
							onEnabledChange={setWorkspaceEnabled}
							onToggleUntracked={toggleUntracked}
							progress={relayProgress}
							selectedUntracked={selectedUntracked}
						/>
					) : null}

					<div className="grid gap-2">
						<Label htmlFor="rnp-context-note">Context note (optional)</Label>
						<Textarea
							disabled={locked}
							id="rnp-context-note"
							maxLength={8000}
							onChange={(event) => setContextNote(event.target.value)}
							placeholder="Add a short, visible note for the next node"
							value={contextNote}
						/>
						<p className="text-muted-foreground text-xs">
							The destination saves this as a visible user message, never as a
							hidden system instruction.
						</p>
					</div>

					<label className="flex items-start gap-3 text-sm">
						<input
							checked={includeAgentHint}
							className="mt-0.5 size-4 accent-foreground"
							disabled={locked}
							onChange={(event) => setIncludeAgentHint(event.target.checked)}
							type="checkbox"
						/>
						<span>
							Suggest the same agent if it exists on the destination. The target
							node still decides which installed agent can run.
						</span>
					</label>

					{error ? (
						<p
							className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-status-destructive"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>

				<DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between">
					<Button
						disabled={pending}
						onClick={() => void handleCopyLink()}
						variant="ghost"
					>
						{copied ? "Handoff link copied" : "Copy handoff link"}
					</Button>
					<Button
						disabled={!(preview && selectedName) || pending || workspaceBlocked}
						onClick={() => void handleContinue()}
					>
						{pending
							? "Moving reviewed context…"
							: attemptedBundle
								? "Retry same handoff"
								: "Continue on selected node"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
