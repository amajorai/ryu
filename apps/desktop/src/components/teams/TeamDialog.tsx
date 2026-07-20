import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { type FormEvent, useEffect, useState } from "react";
import { AgentLogo, engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	COORDINATION_OPTIONS,
	type Coordination,
	type Team,
} from "@/src/lib/api/teams.ts";

export interface TeamDraft {
	coordination: Coordination;
	description: string | null;
	leadAgentId: string | null;
	/** Ordered member agent ids — order drives round-robin turns. */
	members: string[];
	name: string;
}

/** The fields the dialog needs to list and brand a selectable agent. */
export interface TeamAgentOption {
	builtIn?: boolean | null;
	engine?: string | null;
	id: string;
	name: string;
}

/**
 * Create-or-edit dialog for an agent team. Owns the team's name, description,
 * coordination strategy, members, and (for debate/router) the lead agent.
 * Members are added and removed inline here; dragging an agent onto a team in
 * the sidebar is a shortcut for the same thing, not the only path.
 */
export function TeamDialog({
	open,
	onClose,
	onSubmit,
	team,
	agents,
}: {
	open: boolean;
	onClose: () => void;
	onSubmit: (draft: TeamDraft) => Promise<void>;
	/** The team being edited, or null when creating a new one. */
	team: Team | null;
	/** Every agent that can be added to the team. */
	agents: readonly TeamAgentOption[];
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [coordination, setCoordination] = useState<Coordination>("broadcast");
	const [leadAgentId, setLeadAgentId] = useState<string | null>(null);
	const [members, setMembers] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-seed the form whenever a different team (or create mode) is opened.
	useEffect(() => {
		if (open) {
			setName(team?.name ?? "");
			setDescription(team?.description ?? "");
			setCoordination(team?.coordination ?? "broadcast");
			setLeadAgentId(team?.leadAgentId ?? null);
			setMembers(team?.members ?? []);
			setError(null);
		}
	}, [open, team]);

	const isEdit = team !== null;
	// The lead only matters for strategies that designate one.
	const needsLead =
		coordination === "debate-synthesis" || coordination === "router";

	const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
	const agentEngine = (id: string) => {
		const agent = agents.find((a) => a.id === id);
		return agent ? engineForAgent(agent) : null;
	};

	// Keep member order stable: append on add, filter on remove. Never derive
	// from the agents list — that would silently reorder round-robin turns.
	const addMember = (id: string) =>
		setMembers((prev) => (prev.includes(id) ? prev : [...prev, id]));
	const removeMember = (id: string) => {
		setMembers((prev) => prev.filter((m) => m !== id));
		// The lead must stay a member; drop it if its agent just left.
		setLeadAgentId((prev) => (prev === id ? null : prev));
	};

	const candidates = agents.filter((a) => !members.includes(a.id));

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSubmit({
				name: name.trim(),
				description: description.trim() || null,
				coordination,
				leadAgentId: needsLead ? leadAgentId : null,
				members,
			});
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save team");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>{isEdit ? "Edit team" : "New team"}</DialogTitle>
						<DialogDescription>
							A team is a group of agents you can call together with{" "}
							<code>@team</code> in chat.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-4 py-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="team-name">Name</Label>
							<Input
								id="team-name"
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. Research"
								value={name}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="team-description">Description (optional)</Label>
							<Input
								id="team-description"
								onChange={(e) => setDescription(e.target.value)}
								placeholder="What is this team for?"
								value={description}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Members</Label>
							{members.length === 0 ? (
								<p className="text-muted-foreground text-xs">
									No members yet. Add agents below.
								</p>
							) : (
								<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
									{members.map((memberId) => (
										<li
											className="flex h-8 items-center gap-2 rounded-md bg-muted/40 px-2"
											key={memberId}
										>
											<AgentLogo
												className="size-4 shrink-0 object-contain"
												engine={agentEngine(memberId)}
												size="16px"
											/>
											<span className="min-w-0 flex-1 truncate text-sm">
												{agentName(memberId)}
											</span>
											<button
												aria-label={`Remove ${agentName(memberId)}`}
												className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
												onClick={() => removeMember(memberId)}
												type="button"
											>
												<HugeiconsIcon
													className="size-3.5"
													icon={Cancel01Icon}
												/>
											</button>
										</li>
									))}
								</ul>
							)}
							{candidates.length > 0 ? (
								<div className="flex flex-col gap-1">
									<p className="text-muted-foreground text-xs">Add an agent</p>
									<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
										{candidates.map((agent) => (
											<li key={agent.id}>
												<button
													className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-muted"
													onClick={() => addMember(agent.id)}
													type="button"
												>
													<AgentLogo
														className="size-4 shrink-0 object-contain"
														engine={engineForAgent(agent)}
														size="16px"
													/>
													<span className="min-w-0 flex-1 truncate text-sm">
														{agent.name}
													</span>
													<HugeiconsIcon
														className="size-3.5 shrink-0 text-muted-foreground"
														icon={Add01Icon}
													/>
												</button>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="team-coordination">How members respond</Label>
							<Select
								items={COORDINATION_OPTIONS.map((o) => ({
									value: o.value,
									label: o.label,
								}))}
								onValueChange={(v) => v && setCoordination(v as Coordination)}
								value={coordination}
							>
								<SelectTrigger id="team-coordination">
									<SelectValue placeholder="Pick a strategy" />
								</SelectTrigger>
								<SelectContent>
									{COORDINATION_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								{
									COORDINATION_OPTIONS.find((o) => o.value === coordination)
										?.description
								}
							</p>
						</div>
						{needsLead && members.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="team-lead">
									{coordination === "router" ? "Router agent" : "Lead agent"}
								</Label>
								<Select
									items={members.map((id) => ({
										value: id,
										label: agentName(id),
									}))}
									onValueChange={(v) => setLeadAgentId(v ?? null)}
									value={leadAgentId ?? members[0] ?? ""}
								>
									<SelectTrigger id="team-lead">
										<SelectValue placeholder="Pick the lead" />
									</SelectTrigger>
									<SelectContent>
										{members.map((id) => (
											<SelectItem key={id} value={id}>
												{agentName(id)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									{coordination === "router"
										? "Decides which member should answer each message."
										: "Reads every member's reply and writes the final answer."}
								</p>
							</div>
						) : null}
						{error ? <p className="text-destructive text-sm">{error}</p> : null}
					</div>
					<DialogFooter>
						<Button onClick={onClose} type="button" variant="ghost">
							Cancel
						</Button>
						<Button disabled={busy || !name.trim()} type="submit">
							{busy ? <Spinner className="size-4" /> : null}
							{isEdit ? "Save" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
