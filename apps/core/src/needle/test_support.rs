use ryu_tool_registry::{ToolDescriptor, ToolKind};

pub(crate) fn descriptor(
    id: &str,
    name: &str,
    description: &str,
    kind: ToolKind,
    args: &[(&str, &str)],
) -> ToolDescriptor {
    ToolDescriptor {
        id: id.to_owned(),
        name: name.to_owned(),
        description: description.to_owned(),
        kind,
        arg_names: args.iter().map(|(name, _)| (*name).to_owned()).collect(),
        arg_descriptions: args
            .iter()
            .map(|(_, description)| (*description).to_owned())
            .collect(),
        score: None,
        meta: None,
        widget_accessible: false,
        output_template: None,
    }
}

pub(crate) fn web_search() -> ToolDescriptor {
    descriptor(
        "exa.search",
        "search_web",
        "Search the web for current information and news.",
        ToolKind::Mcp,
        &[("query", "The search query.")],
    )
}

pub(crate) fn calendar_create() -> ToolDescriptor {
    descriptor(
        "calendar.create",
        "create_event",
        "Create a calendar event with a title and time.",
        ToolKind::Mcp,
        &[("title", "Event title."), ("time", "Event time.")],
    )
}

pub(crate) fn web_research_skill() -> ToolDescriptor {
    descriptor(
        "skills.web-research",
        "web_research_workflow",
        "Use a step-by-step web research workflow with source checking.",
        ToolKind::Skill,
        &[],
    )
}
