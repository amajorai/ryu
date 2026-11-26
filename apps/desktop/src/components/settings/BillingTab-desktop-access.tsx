import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import {
	type DeclaredUse,
	setDeclaredUse,
	useDeclaredUse,
} from "@/src/hooks/useDeclaredUse.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// The same two answers, with the same wording, as the onboarding step that
// first asks ("How will you use this node?").
const DECLARED_USE_OPTIONS: { label: string; value: DeclaredUse }[] = [
	{ value: "personal", label: "Personal use" },
	{ value: "work", label: "Team or company use" },
];

/**
 * Desktop access. Personal use is free, so the first row only names the
 * resolved state: free, licensed, or an active subscription. Reads the reliable
 * bearer-authed entitlement verdict (NOT the cookie-based useSubscription,
 * which silently fails in the Tauri webview).
 *
 * The second row is the person's own declaration of personal or work use. It
 * is shown and can be changed here; it does not feed the verdict, and nothing
 * is blocked, limited or prompted by it.
 */
export function DesktopAccessSection() {
	const { ready, verdict } = useEntitlementContext();
	const declaredUse = useDeclaredUse();
	if (!(ready && verdict)) {
		return (
			<SettingsSection title="Desktop access">
				<SkeletonRows rows={1} />
			</SettingsSection>
		);
	}

	const reasonLabel = {
		subscription: "Active subscription",
		license: "Licensed",
		"offline-grace": "Active (offline)",
		free: "Free",
	} satisfies Record<typeof verdict.reason, string>;

	return (
		<SettingsSection title="Desktop access">
			<SettingsGroup>
				<SettingsItem
					description={
						verdict.reason === "free"
							? "Every feature on your computer is free. Managed inference and cloud nodes bill separately."
							: "Pro features are unlocked."
					}
					title={reasonLabel[verdict.reason]}
				/>
				<SettingsItem
					actions={
						<Select
							items={DECLARED_USE_OPTIONS}
							onValueChange={(value) => {
								const next = DECLARED_USE_OPTIONS.find(
									(option) => option.value === value
								);
								if (next) {
									setDeclaredUse(next.value);
								}
							}}
							value={declaredUse}
						>
							<SelectTrigger
								className="w-auto max-w-64 shrink-0"
								id="desktop-declared-use"
								size="sm"
							>
								<SelectValue />
							</SelectTrigger>
							{/* The list opens under the trigger, flush with its end edge, so it
							grows into the card instead of out of it. min-w-80 fits the longest
							translated option (German and French, 32 characters). */}
							<SelectContent
								align="end"
								alignItemWithTrigger={false}
								className="min-w-80"
							>
								{DECLARED_USE_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Your answer from setup. Changing it does not block or limit anything."
					title={
						<Label className="font-normal" htmlFor="desktop-declared-use">
							How you use Ryu
						</Label>
					}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
