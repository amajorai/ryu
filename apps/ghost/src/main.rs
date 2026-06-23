mod mcp;
mod refmap;
mod tools;
#[cfg(feature = "ort")]
mod vision_model;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ghost", about = "Ghost — AI eyes and hands for any desktop app")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the MCP server on stdio (for use with Claude Code / MCP clients).
    Mcp,
    /// Print version.
    Version,
    /// Diagnose environment: AX permissions, Chrome debug port, ShowUI model, recipes.
    Doctor,
}

#[tokio::main]
async fn main() {
    // Initialize tracing to stderr so MCP stdout stays clean.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::WARN.into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Mcp     => mcp::server::run().await,
        Commands::Version => println!("ghost {}", env!("CARGO_PKG_VERSION")),
        Commands::Doctor  => run_doctor().await,
    }
}

async fn run_doctor() {
    use ghost_eyes::PlatformAXTree;

    println!("Ghost Doctor — environment check\n");

    // 1. Chrome CDP port
    let chrome_ok = ghost_core::cdp::is_available().await;
    println!(
        "[{}] Chrome remote debugging (port 9222): {}",
        if chrome_ok { "OK" } else { "  " },
        if chrome_ok {
            "available".to_string()
        } else {
            "not found — launch Chrome with --remote-debugging-port=9222".to_string()
        }
    );

    // 2. Accessibility permissions (attempt to build an AX tree)
    let ax_ok = PlatformAXTree::new().is_ok();
    println!(
        "[{}] Accessibility permissions: {}",
        if ax_ok { "OK" } else { "  " },
        if ax_ok {
            "granted".to_string()
        } else {
            "denied — grant in System Settings > Privacy & Security > Accessibility".to_string()
        }
    );

    // 3. ShowUI-2B model file
    let model_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".ghost")
        .join("models")
        .join("showui-2b.onnx");
    let model_ok = model_path.exists();
    println!(
        "[{}] ShowUI-2B model ({}): {}",
        if model_ok { "OK" } else { "  " },
        model_path.display(),
        if model_ok {
            "found".to_string()
        } else {
            "not found — download from https://huggingface.co/showlab/ShowUI-2B-ONNX".to_string()
        }
    );

    // 4. Recipe store
    let recipe_count = ghost_core::recipe::store::RecipeStore::open()
        .and_then(|s| s.list())
        .map(|v| v.len())
        .unwrap_or(0);
    println!("[OK] Recipes: {} loaded from ~/.ghost/recipes/", recipe_count);

    println!();
    if chrome_ok && ax_ok {
        println!("All critical checks passed.");
    } else {
        println!("Fix the issues above, then rerun: ghost doctor");
    }
}
