import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
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
			await authClient.sendVerificationEmail({ email, callbackURL: "/" });
			sileo.success({ title: "Verification email sent — check your inbox." });
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
			className="h-7 shrink-0 px-2 text-warning text-xs hover:text-warning dark:text-warning"
			disabled={loading || cooldown > 0}
			onClick={handleResend}
			size="sm"
			variant="ghost"
		>
			{loading ? (
				<>
					<Spinner className="size-3" />
					Sending…
				</>
			) : cooldown > 0 ? (
				`Resend in ${cooldown}s`
			) : (
				"Resend"
			)}
		</Button>
	);
}
