const stats = [
	{ value: "Configurable", label: "MCP Tools" },
	{ value: "Provider-dependent", label: "Model availability" },
	{ value: "Self-hostable", label: "Ryu Gateway" },
	{ value: "Check availability", label: "Early access" },
];

export default function SocialProof() {
	return (
		<section className="container mx-auto px-4 py-12">
			<div className="mx-auto max-w-5xl rounded-3xl bg-muted/40 px-4 py-12">
				<div className="grid grid-cols-2 gap-8 text-center md:grid-cols-4">
					{stats.map((stat) => (
						<div className="flex flex-col gap-1" key={stat.label}>
							<span className="font-medium text-3xl text-foreground">
								{stat.value}
							</span>
							<span className="text-muted-foreground text-sm">
								{stat.label}
							</span>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
