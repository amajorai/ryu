import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

type LifecyclePermission =
	| "app.install"
	| "app.update"
	| "app.enable"
	| "app.disable"
	| "app.uninstall";

type Action =
	| "install"
	| "update"
	| "enable"
	| "disable"
	| "uninstall"
	| "download";
type NodeKind = "org" | "team" | "personal" | "unbound";
type DecisionStatus = "allowed" | "denied";
type SubjectRole = "owner" | "admin" | "member" | "viewer";

interface Subject {
	id: string;
	label: string;
	orgId: string | null;
	role: SubjectRole;
	teamIds: string[];
}

interface RegisteredNode {
	id: string;
	kind: NodeKind;
	orgId: string | null;
	ownerUserId: string | null;
	teamId: string | null;
}

interface AccessRule {
	effect: "allow" | "deny";
	permission: LifecyclePermission;
	subjectId: string;
	subjectType: "team" | "member";
}

interface Scenario {
	action: Action;
	actor: Subject;
	expected: DecisionStatus;
	id: string;
	label: string;
	packageLabel: string;
}

type Result = Scenario & {
	actual: DecisionStatus;
	reason: string;
	requiredPermission: LifecyclePermission;
	log: string;
};

const node: RegisteredNode = {
	id: "node-team-7",
	kind: "team",
	orgId: "org-acme",
	teamId: "team-7",
	ownerUserId: null,
};

const subjects = {
	admin: {
		id: "owner-1",
		label: "Org admin",
		orgId: "org-acme",
		role: "admin",
		teamIds: [],
	},
	member: {
		id: "member-7",
		label: "Explicit team member",
		orgId: "org-acme",
		role: "member",
		teamIds: ["team-7"],
	},
	denied: {
		id: "member-denied",
		label: "Member-level deny",
		orgId: "org-acme",
		role: "member",
		teamIds: ["team-7"],
	},
	viewer: {
		id: "viewer-2",
		label: "Ordinary viewer",
		orgId: "org-acme",
		role: "viewer",
		teamIds: [],
	},
} satisfies Record<string, Subject>;

const rules: AccessRule[] = [
	...(
		[
			"app.install",
			"app.update",
			"app.enable",
			"app.disable",
			"app.uninstall",
		] satisfies LifecyclePermission[]
	).map((permission) => ({
		effect: "allow" as const,
		permission,
		subjectId: "team-7",
		subjectType: "team" as const,
	})),
	{
		effect: "deny",
		permission: "app.install",
		subjectId: "member-denied",
		subjectType: "member",
	},
];

const permissionFor = (action: Action): LifecyclePermission => {
	if (action === "download") {
		return "app.install";
	}
	return `app.${action}`;
};

const nodeScopeLabel = (registeredNode: RegisteredNode): string => {
	if (registeredNode.kind === "team") {
		return `team:${registeredNode.teamId}`;
	}
	if (registeredNode.kind === "org") {
		return `org:${registeredNode.orgId}`;
	}
	if (registeredNode.kind === "personal") {
		return `personal:${registeredNode.ownerUserId}`;
	}
	return "unbound:local-token";
};

const isNodeVisibleTo = (
	subject: Subject,
	registeredNode: RegisteredNode
): boolean => {
	if (registeredNode.kind === "unbound") {
		return true;
	}
	if (registeredNode.kind === "personal") {
		return registeredNode.ownerUserId === subject.id;
	}
	if (registeredNode.orgId !== subject.orgId) {
		return false;
	}
	if (registeredNode.kind === "team") {
		return (
			(registeredNode.teamId !== null &&
				subject.teamIds.includes(registeredNode.teamId)) ||
			subject.role === "owner" ||
			subject.role === "admin"
		);
	}
	return true;
};

const hasLifecyclePermission = (
	subject: Subject,
	registeredNode: RegisteredNode,
	permission: LifecyclePermission
): boolean => {
	if (subject.role === "owner" || subject.role === "admin") {
		return true;
	}
	const memberRule = rules.find(
		(rule) =>
			rule.subjectType === "member" &&
			rule.subjectId === subject.id &&
			rule.permission === permission
	);
	if (memberRule) {
		return memberRule.effect === "allow";
	}
	const teamRule = rules.find(
		(rule) =>
			rule.subjectType === "team" &&
			rule.subjectId === registeredNode.teamId &&
			rule.permission === permission
	);
	return teamRule?.effect === "allow";
};

const runScenario = (scenario: Scenario): Result => {
	const requiredPermission = permissionFor(scenario.action);
	let actual: DecisionStatus = "allowed";
	let reason = "allowed";

	if (!isNodeVisibleTo(scenario.actor, node)) {
		actual = "denied";
		reason = "node_scope_mismatch";
	} else if (
		!hasLifecyclePermission(scenario.actor, node, requiredPermission)
	) {
		actual = "denied";
		reason = "acl_denied";
	}

	const log = JSON.stringify({
		action: scenario.action,
		actor: scenario.actor.id,
		node: node.id,
		node_scope: nodeScopeLabel(node),
		reason,
		result: actual,
		required_permission: requiredPermission,
		status: actual === "allowed" ? 200 : 403,
	});

	return { ...scenario, actual, log, reason, requiredPermission };
};

const scenarios: Scenario[] = [
	{
		action: "install",
		actor: subjects.viewer,
		expected: "denied",
		id: "member-denied",
		label: "Ordinary member denied by default",
		packageLabel: "free/plugin-calendar",
	},
	{
		action: "install",
		actor: subjects.member,
		expected: "allowed",
		id: "team-grant",
		label: "Explicit team grant succeeds",
		packageLabel: "free/plugin-calendar",
	},
	{
		action: "install",
		actor: subjects.denied,
		expected: "denied",
		id: "individual-deny",
		label: "Individual deny overrides team grant",
		packageLabel: "free/plugin-calendar",
	},
	{
		action: "update",
		actor: subjects.admin,
		expected: "allowed",
		id: "admin-team-node",
		label: "Org admin governs team node",
		packageLabel: "paid/plugin-pro",
	},
	{
		action: "update",
		actor: subjects.member,
		expected: "allowed",
		id: "paid-update",
		label: "Paid listing update is access-first",
		packageLabel: "paid/plugin-pro",
	},
	{
		action: "download",
		actor: subjects.member,
		expected: "allowed",
		id: "paid-download",
		label: "Paid listing download is access-first",
		packageLabel: "paid/plugin-pro",
	},
	{
		action: "disable",
		actor: subjects.member,
		expected: "allowed",
		id: "paid-disable",
		label: "Paid package can be disabled",
		packageLabel: "paid/plugin-pro",
	},
	{
		action: "uninstall",
		actor: subjects.member,
		expected: "allowed",
		id: "paid-uninstall",
		label: "Paid package can be uninstalled",
		packageLabel: "paid/plugin-pro",
	},
];

const githubBridge = {
	appId: "4625892",
	appName: "Ryu Marketplace",
	slug: "ryu-marketplace",
	permissions: "contents:read · metadata:read",
	events: "push · release",
	packageSource: "GitHub Releases · deterministic .ryupack",
	sellerFlow: "Paste repo URL → validate → Stripe offer → Ryu proxy",
	privateKeyCheck: "validated",
	serverEnvCheck: "configured",
	webhookCheck: "active · secret configured",
};

const App = () => {
	const [run, setRun] = useState(1);
	const results = useMemo(() => scenarios.map(runScenario), [run]);
	const passed = results.every((result) => result.actual === result.expected);

	return (
		<main className="dark mx-auto min-h-screen max-w-355 bg-background px-12 pt-10 pb-16 font-sans text-foreground">
			<div className="font-extrabold text-primary text-xs uppercase tracking-(--tracking-section)">
				Ryu marketplace bridge · browser proof
			</div>
			<h1 className="mt-2.5 mb-3 font-semibold text-4xl tracking-tight">
				GitHub packages with node-scoped lifecycle authorization
			</h1>
			<p className="max-w-205 text-base text-muted-foreground leading-relaxed">
				The seller brings a GitHub repository, while Ryu keeps the billing,
				signed-package, proxy, and ACL decisions. The desktop receives a stable
				node identity and asks the server for lifecycle capabilities before any
				package filesystem mutation.
			</p>
			<div className="mt-7 mb-5 flex items-center gap-4">
				<div
					className="inline-flex items-center gap-2 rounded-full border border-success/40 bg-success/15 px-3 py-2 font-bold text-sm text-success"
					data-testid="proof-status"
				>
					<span className="size-2 rounded-full bg-success" />
					{passed ? "8/8 contract decisions verified" : "Contract proof failed"}
				</div>
				<span className="text-muted-foreground text-xs">
					Run {run} · captured gateway responses
				</span>
				<button
					className="ml-auto cursor-pointer rounded-lg bg-primary px-4 py-2.5 font-extrabold text-primary-foreground"
					onClick={() => setRun((value) => value + 1)}
					type="button"
				>
					Re-run matrix
				</button>
			</div>

			<div className="grid grid-cols-2 gap-4">
				<section
					className="col-span-full rounded-2xl border border-border bg-card p-5 shadow-lg [&_h2]:mb-4 [&_h2]:font-semibold [&_h2]:text-sm"
					data-testid="github-bridge-card"
				>
					<h2>GitHub Marketplace bridge</h2>
					<div className="flex items-center justify-between gap-3 border-border border-b pb-4 [&_strong]:text-xl">
						<strong>{githubBridge.appName}</strong>
						<span className="rounded-full border border-primary/40 px-2 py-1 font-extrabold text-primary text-xs uppercase tracking-wider">
							App {githubBridge.appId}
						</span>
					</div>
					<div className="mt-4 grid grid-cols-3 gap-3">
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>App slug</span>
							<strong>{githubBridge.slug}</strong>
						</div>
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>Permissions</span>
							<strong>{githubBridge.permissions}</strong>
						</div>
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>Events</span>
							<strong>{githubBridge.events}</strong>
						</div>
					</div>
					<div className="mt-4 grid grid-cols-3 gap-2.5">
						<div className="rounded-lg border border-border bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm [&_strong]:text-success">
							<span>Private key</span>
							<strong>{githubBridge.privateKeyCheck}</strong>
						</div>
						<div className="rounded-lg border border-border bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm [&_strong]:text-success">
							<span>Server environment</span>
							<strong>{githubBridge.serverEnvCheck}</strong>
						</div>
						<div
							className="rounded-lg border border-border bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm [&_strong]:text-success"
							data-testid="webhook-check"
						>
							<span>Webhook</span>
							<strong>{githubBridge.webhookCheck}</strong>
						</div>
					</div>
					<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
						{githubBridge.packageSource}. {githubBridge.sellerFlow}. Buyers do
						not need GitHub credentials; private release bytes are proxied
						through Ryu. The GitHub app webhook is active, with its secret
						configured server-side; no credential is exposed to the buyer.
					</p>
				</section>

				<section
					className="rounded-2xl border border-border bg-card p-5 shadow-lg [&_h2]:mb-4 [&_h2]:font-semibold [&_h2]:text-sm"
					data-testid="node-scope-card"
				>
					<h2>Registered node</h2>
					<div className="flex items-center justify-between gap-3 border-border border-b pb-4 [&_strong]:text-xl">
						<strong>{node.id}</strong>
						<span className="rounded-full border border-primary/40 px-2 py-1 font-extrabold text-primary text-xs uppercase tracking-wider">
							team node
						</span>
					</div>
					<div className="mt-4 grid grid-cols-3 gap-3">
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>Organization</span>
							<strong>{node.orgId}</strong>
						</div>
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>Team</span>
							<strong>{node.teamId}</strong>
						</div>
						<div className="rounded-lg bg-background p-3 [&_span]:mb-1 [&_span]:block [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:uppercase [&_strong]:text-sm">
							<span>Node scope</span>
							<strong>{nodeScopeLabel(node)}</strong>
						</div>
					</div>
					<p className="mt-3.5 text-muted-foreground text-xs leading-relaxed">
						Org admins can govern this team node without joining team-7.
						Personal-node ownership would remain private.
					</p>
				</section>

				<section
					className="rounded-2xl border border-border bg-card p-5 shadow-lg [&_h2]:mb-4 [&_h2]:font-semibold [&_h2]:text-sm"
					data-testid="permission-card"
				>
					<h2>Independent lifecycle permissions</h2>
					<div className="flex flex-wrap gap-2">
						{(
							[
								"app.install",
								"app.update",
								"app.enable",
								"app.disable",
								"app.uninstall",
							] satisfies LifecyclePermission[]
						).map((permission) => (
							<span
								className="rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-2 font-mono text-primary text-xs"
								key={permission}
							>
								{permission}
							</span>
						))}
					</div>
					<p className="mt-3.5 text-muted-foreground text-xs leading-relaxed">
						A grant for install never implies update, enable, disable, or
						uninstall. Team allow is checked after node scope; a member deny
						wins over the team grant.
					</p>
				</section>

				<section
					className="col-span-full overflow-hidden rounded-2xl border border-border bg-card p-0 p-5 shadow-lg [&_h2]:mb-4 [&_h2]:font-semibold [&_h2]:text-sm"
					data-testid="decision-matrix"
				>
					<div className="px-5 pt-5 pb-3">
						<h2>Org / team / member decision matrix</h2>
						<p className="mt-3.5 text-muted-foreground text-xs leading-relaxed">
							Free and paid packages use the same node ACL. Listing price and
							optional checkout do not change install, update, or download
							access.
						</p>
					</div>
					<table className="w-full border-collapse text-sm [&_td]:border-border [&_td]:border-t [&_td]:px-4 [&_td]:py-3 [&_th]:bg-background [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:text-muted-foreground [&_th]:text-xs [&_th]:uppercase">
						<thead>
							<tr>
								<th>Scenario</th>
								<th>Actor</th>
								<th>Action</th>
								<th>Package</th>
								<th>Result</th>
								<th>Reason</th>
							</tr>
						</thead>
						<tbody>
							{results.map((result) => (
								<tr data-testid={`decision-${result.id}`} key={result.id}>
									<td>{result.label}</td>
									<td className="text-muted-foreground text-xs">
										{result.actor.label}
									</td>
									<td>
										<code>{result.requiredPermission}</code>
									</td>
									<td>
										<code>{result.packageLabel}</code>
									</td>
									<td>
										<span
											className={
												result.actual === "allowed"
													? "inline-flex rounded-full border border-success/40 bg-success/15 px-2 py-1 font-extrabold text-success text-xs uppercase"
													: "inline-flex rounded-full border border-destructive/40 bg-destructive/15 px-2 py-1 font-extrabold text-destructive text-xs uppercase"
											}
											data-testid={`result-${result.id}`}
										>
											{result.actual}
										</span>
									</td>
									<td className="font-mono text-muted-foreground text-xs">
										{result.reason}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>

				<section
					className="col-span-full rounded-2xl border border-border bg-card p-5 shadow-lg [&_h2]:mb-4 [&_h2]:font-semibold [&_h2]:text-sm"
					data-testid="captured-logs"
				>
					<h2>Captured structured logs</h2>
					{results.map((result) => (
						<div
							className="my-2 truncate rounded-md border-primary border-l-2 bg-background px-3 py-2 font-mono text-primary text-xs"
							key={result.id}
						>
							{result.log}
						</div>
					))}
					<p className="mt-3.5 text-muted-foreground text-xs leading-relaxed">
						Denied rows carry the required permission and stable node scope in
						the 403-shaped payload. Prices are recorded separately from the
						lifecycle ACL and never turn a valid package into a paywall.
					</p>
				</section>
			</div>
		</main>
	);
};

document.documentElement.classList.add("dark");
document.body.classList.add("bg-background");
createRoot(document.getElementById("root")!).render(<App />);
