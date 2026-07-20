import {
	Avatar,
	AvatarFallback,
	AvatarGroup,
	AvatarImage,
} from "@ryu/ui/components/avatar";

export function HeroAvatarSocialProof() {
	return (
		<div className="flex items-center gap-1.5">
			<AvatarGroup>
				<Avatar className="size-7">
					<AvatarImage
						alt="Liam Thompson"
						src="https://images.unsplash.com/photo-1542595913-85d69b0edbaf?w=96&h=96&dpr=2&q=80"
					/>
					<AvatarFallback>LT</AvatarFallback>
				</Avatar>
				<Avatar className="size-7">
					<AvatarImage
						alt="Nick Johnson"
						src="https://images.unsplash.com/photo-1485206412256-701ccc5b93ca?w=96&h=96&dpr=2&q=80"
					/>
					<AvatarFallback>NJ</AvatarFallback>
				</Avatar>
				<Avatar className="size-7">
					<AvatarImage
						alt="Maria Garcia"
						src="https://images.unsplash.com/photo-1620075225255-8c2051b6c015?w=96&h=96&dpr=2&q=80"
					/>
					<AvatarFallback>MG</AvatarFallback>
				</Avatar>
				<Avatar className="size-7">
					<AvatarImage alt="@leerob" src="https://github.com/leerob.png" />
					<AvatarFallback>CH</AvatarFallback>
				</Avatar>
			</AvatarGroup>

			<p className="me-1.5 text-muted-foreground text-xs">
				Trusted by <span className="font-semibold text-foreground">1.7k</span>{" "}
				users.
			</p>
		</div>
	);
}
