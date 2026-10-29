import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useRef, useState } from "react";
import { sileo } from "sileo";
import { authClient } from "@/lib/auth-client.ts";

const COOLDOWN_SECONDS = 60;

interface ResendVerificationButtonProps {
	email: string;
}

export function ResendVerificationButton({
	email,
}: ResendVerificationButtonProps) {
	const tl = useLiteralMessages();
	const [loading, setLoading] = useState(false);
	const [cooldown, setCooldown] = useState(0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, []);

	const handleResend = async () => {
		if (loading || cooldown > 0) {
			return;
		}
		setLoading(true);
		try {
			// The auth client resolves with `{ error }` when the server refuses
			// rather than throwing, so a refusal must not start the cooldown.
			const result = await authClient.sendVerificationEmail({
				email,
				callbackURL: "/",
			});
			if (result.error) {
				throw new Error(result.error.message ?? "Verification email refused");
			}
			sileo.success({ title: "Verification email sent. Check your inbox." });
			setCooldown(COOLDOWN_SECONDS);
			intervalRef.current = setInterval(() => {
				setCooldown((prev) => {
					if (prev <= 1) {
						clearInterval(intervalRef.current!);
						intervalRef.current = null;
						return 0;
					}
					return prev - 1;
				});
			}, 1000);
		} catch {
			sileo.error({
				title: "Failed to send verification email. Please try again.",
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<Button
			appearance="service-retry"
			className="shrink-0"
			disabled={cooldown > 0}
			loading={loading}
			onClick={handleResend}
			size="sm"
			typography="compact"
			variant="ghost"
		>
			{loading
				? "Sending…"
				: cooldown > 0
					? tl("Resend in {cooldown}s", { cooldown: String(cooldown) })
					: "Resend"}
		</Button>
	);
}
