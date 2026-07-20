"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	BookOpen,
	Download,
	HelpCircle,
	Home,
	LayoutDashboard,
	User,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProgressiveBlur } from "./progressive-blur.tsx";

interface MobileNavProps {
	className?: string;
	signedIn?: boolean;
}

export function MobileNav({ className, signedIn = false }: MobileNavProps) {
	const pathname = usePathname();
	const session = signedIn;

	// /download is auth-gated server-side, so the entry can point straight at it
	// for everyone: signed-out taps get bounced to login, signed-in taps land on
	// the page.
	const items = [
		{ href: "/", icon: Home, label: "Home" },
		{ href: "/download", icon: Download, label: "Download" },
		{
			href: session ? "/dashboard" : "/pricing",
			icon: LayoutDashboard,
			label: "Dashboard",
		},
		{ href: "/blog", icon: BookOpen, label: "Blog" },
		{ href: "/help", icon: HelpCircle, label: "Help" },
		{
			href: session ? "/profile" : "/login",
			icon: User,
			label: session ? "Account" : "Sign In",
		},
	];

	return (
		<div
			className={cn("fixed right-0 bottom-0 left-0 z-50 md:hidden", className)}
		>
			<div className="relative h-20">
				<ProgressiveBlur
					blurAmount="24px"
					height="80px"
					position="bottom"
					useThemeBackground
				/>
				<nav className="relative z-10 grid h-full grid-cols-6 items-center">
					{items.map(({ href, icon: Icon, label }) => {
						const isActive =
							href === "/" ? pathname === "/" : pathname.startsWith(href);
						return (
							<Link
								className={cn(
									"flex w-full flex-col items-center justify-center gap-1 rounded-lg py-2 transition-colors",
									isActive
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground"
								)}
								href={href as Route}
								key={href}
							>
								<Icon className="size-5" />
								<span className="text-xs">{label}</span>
							</Link>
						);
					})}
				</nav>
			</div>
		</div>
	);
}
