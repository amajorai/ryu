mod agent;
mod capture;
mod capture_engine;
mod config;
mod intelligence;
mod llm;
mod memory;
mod mimicry;
mod ocr;
mod server;
mod utils;
mod video;

use std::sync::Arc;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "shadow")]
#[command(about = "Personal intelligence engine", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the Shadow sidecar
    Start {
        /// Port for HTTP server
        #[arg(short, long, default_value = "3030")]
        port: u16,

        /// LLM base URL (OpenAI-compatible)
        #[arg(long, env = "SHADOW_LLM_BASE_URL")]
        llm_base_url: Option<String>,

        /// LLM model name
        #[arg(long, env = "SHADOW_LLM_MODEL")]
        llm_model: Option<String>,

        /// LLM API key (empty for local providers)
        #[arg(long, env = "SHADOW_LLM_API_KEY", default_value = "")]
        llm_api_key: String,
    },
    Stop,
    Status,
    Search {
        #[arg(short, long)]
        query: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Start {
            port,
            llm_base_url,
            llm_model,
            llm_api_key,
        } => {
            let mut config = config::Config::new();
            config.port = port;

            if let Some(url) = llm_base_url {
                config.llm.base_url = url;
            }
            if let Some(model) = llm_model {
                config.llm.model = model;
            }
            if !llm_api_key.is_empty() {
                config.llm.api_key = llm_api_key;
            }

            tracing::info!("Starting Shadow v{}", env!("CARGO_PKG_VERSION"));
            tracing::info!("Data directory: {}", config.data_dir.display());
            tracing::info!("LLM: {} @ {}", config.llm.model, config.llm.base_url);

            // 1. Initialize storage
            shadow_core::init_storage(config.data_dir.to_string_lossy().to_string())?;
            tracing::info!("✓ Storage initialized");

            // 2. Initialize memory
            let memory_db_path = config.memory_db_path();
            if let Err(e) = memory::init_memory(&memory_db_path) {
                tracing::warn!("Memory init failed (non-fatal): {}", e);
            } else {
                tracing::info!("✓ Memory store initialized");
            }

            // 3. Initialize LLM orchestrator
            let orchestrator = Arc::new(llm::orchestrator::LlmOrchestrator::new(&config.llm));
            tracing::info!("✓ LLM orchestrator initialized");

            // 3a. Download Whisper model if not present (non-fatal)
            {
                let mgr = intelligence::ModelManager::new(&config.data_dir);
                if !mgr.is_available(&intelligence::WHISPER_TINY_MODEL) {
                    let mgr2 = mgr; // move into async block
                    tokio::spawn(async move {
                        if let Err(e) = mgr2.download(&intelligence::WHISPER_TINY_MODEL).await {
                            tracing::warn!("Whisper model download failed: {}", e);
                        } else {
                            tracing::info!("✓ Whisper tiny model downloaded");
                        }
                    });
                } else {
                    tracing::info!("✓ Whisper model available");
                }
            }

            // 4. Initialize procedure store
            let proc_db_path = config.data_dir.join("indices").join("procedures.db");
            let procedure_store = Arc::new(std::sync::Mutex::new(
                mimicry::ProcedureStore::new(&proc_db_path)
                    .unwrap_or_else(|_| panic!("Failed to open procedure store")),
            ));

            // 5. Initialize summary store
            let summary_db_path = config.data_dir.join("indices").join("summaries.db");
            let summary_store = Arc::new(std::sync::Mutex::new(
                intelligence::SummaryStore::new(&summary_db_path)
                    .unwrap_or_else(|_| panic!("Failed to open summary store")),
            ));

            // 6. Initialize proactive store
            let proactive_db_path = config.data_dir.join("indices").join("proactive.db");
            let proactive_store = Arc::new(tokio::sync::Mutex::new(
                intelligence::ProactiveStore::new(&proactive_db_path)
                    .unwrap_or_else(|_| panic!("Failed to open proactive store")),
            ));

            // 6a. Initialize episode store (non-fatal)
            let context_db_path = config.data_dir.join("indices").join("context.db");
            let episode_store: Option<Arc<std::sync::Mutex<intelligence::EpisodeStore>>> =
                match intelligence::EpisodeStore::new(&context_db_path) {
                    Ok(store) => {
                        tracing::info!("✓ Episode store initialized");
                        Some(Arc::new(std::sync::Mutex::new(store)))
                    }
                    Err(e) => {
                        tracing::warn!("Episode store init failed (non-fatal): {}", e);
                        None
                    }
                };

            // 6b. Initialize safety gate
            let safety_gate = Arc::new(intelligence::SafetyGate::new(Some(Arc::clone(
                &orchestrator,
            ))));
            tracing::info!("✓ Safety gate initialized");

            // 7. Initialize mimicry coordinator
            let mimicry_coord = Arc::new(mimicry::MimicryCoordinator::new(
                Arc::clone(&orchestrator),
                Arc::clone(&procedure_store),
                Arc::clone(&safety_gate),
                episode_store.clone(),
            ));

            // 8. Start capture engine
            let mut capture_engine = capture_engine::CaptureEngine::new()?;
            capture_engine.set_data_dir(config.data_dir.clone());
            capture_engine.start().await?;
            tracing::info!("✓ Capture engine started");

            // 8a. Start passive capture sources (clipboard/fs/git/terminal/
            // notifications/calendar). Each is non-fatal and independently gated.
            capture::passive::start_all(config.data_dir.clone());

            // 8a. Snapshot handles for live current-context queries.
            let window_tracker_handle = Arc::new(tokio::sync::Mutex::new(
                capture::window::PlatformWindowTracker::new()?,
            ));
            let ax_tree_handle = Arc::new(tokio::sync::Mutex::new(
                capture::accessibility::PlatformAXTree::new()?,
            ));

            // 6.5. Initialize TrustTuner
            let trust_params_path = config.data_dir.join("data").join("trust_params.json");
            let trust_tuner = Arc::new(std::sync::Mutex::new(intelligence::TrustTuner::load(
                &trust_params_path,
            )));
            tracing::info!("✓ TrustTuner initialized");

            // 6.6. Initialize PatternStore
            let pattern_store_dir = config.data_dir.join("data").join("patterns");
            let pattern_store = Arc::new(std::sync::Mutex::new(agent::PatternStore::new(
                &pattern_store_dir,
            )));
            tracing::info!("✓ PatternStore initialized");

            // 6.7. Initialize DeliveryManager
            let delivery_manager = Arc::new(intelligence::DeliveryManager::new(
                Arc::clone(&trust_tuner),
                true, // push enabled by default
            ));
            tracing::info!("✓ DeliveryManager initialized");

            // 6.8. Initialize SummaryQueue
            let summary_queue =
                Arc::new(tokio::sync::Mutex::new(intelligence::SummaryQueue::new()));
            tracing::info!("✓ SummaryQueue initialized");

            // 9. Start proactive heartbeat in background
            {
                let orch = Arc::clone(&orchestrator);
                let ps = Arc::clone(&proactive_store);
                let es = episode_store.clone();
                let trust = Arc::clone(&trust_tuner);
                tokio::spawn(intelligence::proactive::run_proactive_heartbeat(
                    orch,
                    ps,
                    es,
                    Some(trust),
                ));
                tracing::info!("✓ Proactive heartbeat started");
            }

            // 9.5. Start SemanticConsolidator on 30-min heartbeat
            if let Some(ep_store) = episode_store.clone() {
                let orch = Arc::clone(&orchestrator);
                tokio::spawn(async move {
                    let mut consolidator = memory::SemanticConsolidator::new();
                    loop {
                        tokio::time::sleep(tokio::time::Duration::from_secs(30 * 60)).await;
                        // Phase 1: Load episodes (sync, lock released before await)
                        let episodes = {
                            match ep_store.lock() {
                                Ok(s) => s.load_recent(50).unwrap_or_default(),
                                Err(_) => continue,
                            }
                        };
                        // Phase 2: LLM extraction (async, no lock held)
                        let facts = consolidator.extract_facts(&episodes, &orch).await;
                        if facts.is_empty() {
                            continue;
                        }
                        // Phase 3: Apply facts to store (sync, lock acquired fresh)
                        if let Some(mem_store) = memory::MEMORY_STORE.get() {
                            if let Ok(mem) = mem_store.lock() {
                                match consolidator.apply_facts(&facts, &mem.semantic) {
                                    Ok(n) if n > 0 => {
                                        tracing::info!(
                                            "Consolidator: upserted {} semantic facts",
                                            n
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                });
                tracing::info!("✓ SemanticConsolidator heartbeat started");
            }

            // 9.6. Start full-text indexer heartbeat. `index_recent_events` pulls
            // every event written since the last checkpoint into the Tantivy index
            // (app context + the passive clipboard/fs/git/terminal/notification/
            // calendar tracks). Without this loop nothing reaches `/search`.
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                    match tokio::task::spawn_blocking(shadow_core::index_recent_events).await {
                        Ok(Ok(n)) if n > 0 => tracing::debug!("Search indexer: +{n} docs"),
                        Ok(Err(e)) => tracing::trace!("Search indexer: {e}"),
                        _ => {}
                    }
                }
            });
            tracing::info!("✓ Full-text search indexer started");

            // 9.7. Prune old screen keyframes by age. Direct JPEG keyframes (the
            // out-of-the-box timeline frames) have no backing MP4 segment, so the
            // segment-keyed retention sweep never touches them — they would grow
            // unbounded on disk. Delete keyframes older than the total retention
            // window (hot + warm days) once on startup, then daily.
            {
                let retain_days = (config.retention.hot_days + config.retention.warm_days) as u64;
                tokio::spawn(async move {
                    loop {
                        let now_us = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_micros() as u64)
                            .unwrap_or(0);
                        let cutoff = now_us.saturating_sub(retain_days * 86_400 * 1_000_000);
                        match tokio::task::spawn_blocking(move || {
                            shadow_core::prune_keyframes_before(cutoff)
                        })
                        .await
                        {
                            Ok(Ok(paths)) if !paths.is_empty() => {
                                for p in &paths {
                                    let _ = std::fs::remove_file(p);
                                }
                                tracing::info!("Keyframe retention: pruned {} frames", paths.len());
                            }
                            Ok(Err(e)) => tracing::trace!("Keyframe retention: {e}"),
                            _ => {}
                        }
                        tokio::time::sleep(tokio::time::Duration::from_secs(86_400)).await;
                    }
                });
                tracing::info!("✓ Keyframe retention sweep started");
            }

            // 9.8. Start the meeting auto-detection poller. Watches the OS for a
            // process using the microphone (the Granola/Notion mechanic) and
            // reports it to Core, which decides whether it's a meeting and prompts
            // the user. Core URL is overridable; defaults to the local node.
            {
                let core_url = std::env::var("RYU_CORE_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "http://127.0.0.1:7980".to_string());
                capture::detect::spawn_poller(core_url);
                tracing::info!("✓ Meeting auto-detection poller started");
            }

            // 10. Start HTTP server (blocks)
            let state = server::AppState {
                config: config.clone(),
                orchestrator: Some(orchestrator),
                procedure_store: Some(procedure_store),
                proactive_store: Some(proactive_store),
                summary_store: Some(summary_store),
                mimicry: Some(mimicry_coord),
                pattern_store: Some(pattern_store),
                trust_tuner: Some(trust_tuner),
                delivery_manager: Some(delivery_manager),
                summary_queue: Some(summary_queue),
                window_tracker: Some(window_tracker_handle),
                ax_tree: Some(ax_tree_handle),
            };
            server::run_server(state).await?;
        }

        Commands::Stop => {
            let port = 3030u16;
            match reqwest::Client::new()
                .get(format!("http://127.0.0.1:{}/stop", port))
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
            {
                Ok(_) => println!("Shadow stopped."),
                Err(e) => eprintln!("Shadow is not running or could not be reached: {}", e),
            }
        }

        Commands::Status => {
            let port = 3030u16;
            match reqwest::Client::new()
                .get(format!("http://127.0.0.1:{}/health", port))
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
            {
                Ok(r) => {
                    if let Ok(body) = r.json::<serde_json::Value>().await {
                        println!("Shadow is running — {}", body);
                    } else {
                        println!("Shadow is running");
                    }
                }
                Err(_) => println!("Shadow is not running"),
            }
        }

        Commands::Search { query } => {
            shadow_core::init_storage(
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".shadow")
                    .to_string_lossy()
                    .to_string(),
            )?;
            match shadow_core::search_text(query, 100) {
                Ok(results) => {
                    println!("Found {} results", results.len());
                    for r in results {
                        println!("  - {} (ts={})", r.app_name, r.ts);
                    }
                }
                Err(e) => tracing::error!("Search failed: {}", e),
            }
        }
    }

    Ok(())
}
