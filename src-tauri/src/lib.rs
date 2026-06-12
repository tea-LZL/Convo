mod commands;
mod db;
mod ollama_setup;
mod providers;
mod services;
mod state;
mod streams;
mod themes;

use commands::attachments as attachments_cmd;
use commands::chat as chat_cmd;
use commands::chat_stream as chat_stream_cmd;
use commands::compare as compare_cmd;
use commands::documents as documents_cmd;
use commands::memory as memory_cmd;
use commands::models as models_cmd;
use commands::notes as notes_cmd;
use commands::search as search_cmd;
use commands::sessions as sessions_cmd;
use commands::settings as settings_cmd;
use commands::slash as slash_cmd;
use commands::tasks as tasks_cmd;
use commands::themes as themes_cmd;
use services as services_mod;

use state::AppState;

pub fn run() {
    let pool = match db::init_pool() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("FATAL: DB init failed: {}", e);
            std::process::exit(1);
        }
    };
    if let Err(e) = db::run_migrations(&pool) {
        eprintln!("FATAL: DB migration failed: {}", e);
        std::process::exit(1);
    }
    if let Err(e) = services_mod::ensure_default_ollama_provider(&pool) {
        eprintln!("WARN: default provider init: {}", e);
    }
    if let Err(e) = services_mod::ensure_builtin_presets(&pool) {
        eprintln!("WARN: builtin presets: {}", e);
    }

    // Migrate legacy JSON on first run
    if db::legacy::legacy_exists() {
        match db::legacy::import_legacy_into(&pool) {
            Ok(n) => eprintln!("Imported {} conversations from legacy store", n),
            Err(e) => eprintln!("WARN: legacy import failed: {}", e),
        }
    }

    state::set_pool_static(pool.clone());
    let app_state = AppState::new(pool.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(pool.clone())
        .manage(streams::ActiveStreams::new())
        .manage(app_state)
        .setup(|app| {
            let handle = app.handle().clone();
            services_mod::init_logger(&handle);
            // Ensure built-in themes are inserted
            if let Err(e) = services_mod::ensure_builtin_themes() {
                eprintln!("WARN: builtin themes: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Settings + app info
            settings_cmd::get_setting,
            settings_cmd::set_setting,
            settings_cmd::get_all_settings,
            services_mod::app_info,
            services_mod::open_data_dir,
            // Sessions
            sessions_cmd::list_sessions,
            sessions_cmd::create_session,
            sessions_cmd::rename_session,
            sessions_cmd::update_session_model,
            sessions_cmd::delete_session,
            sessions_cmd::set_session_pinned,
            sessions_cmd::set_session_archived,
            sessions_cmd::search_sessions,
            sessions_cmd::export_session_markdown,
            // Models
            models_cmd::list_models_for_provider,
            models_cmd::list_all_models,
            models_cmd::refresh_models,
            models_cmd::list_local_servers,
            // Messages + chat
            chat_cmd::list_messages,
            chat_cmd::save_messages,
            chat_cmd::append_message,
            chat_stream_cmd::chat_stream_v2,
            chat_stream_cmd::cancel_chat_v2,
            // Presets
            chat_cmd::list_presets,
            chat_cmd::upsert_preset,
            chat_cmd::delete_preset,
            // Providers
            services_mod::list_providers,
            services_mod::add_provider,
            services_mod::update_provider,
            services_mod::delete_provider,
            services_mod::probe_provider,
            services_mod::discover_local_servers,
            // Models (Ollama-specific for now; phase 2 will refactor)
            crate::ollama_setup::list_models,
            crate::ollama_setup::get_model_context_length,
            crate::ollama_setup::get_running_models,
            crate::ollama_setup::check_ollama_status,
            crate::ollama_setup::get_model_catalog,
            crate::ollama_setup::pull_model,
            crate::ollama_setup::delete_model,
            crate::ollama_setup::create_custom_model,
            // Themes
            themes_cmd::list_themes,
            themes_cmd::save_theme,
            themes_cmd::delete_theme,
            // Notes
            notes_cmd::list_notes,
            notes_cmd::upsert_note,
            notes_cmd::delete_note,
            // Tasks
            tasks_cmd::list_tasks,
            tasks_cmd::upsert_task,
            tasks_cmd::delete_task,
            tasks_cmd::complete_task,
            // Memory
            memory_cmd::list_memory,
            memory_cmd::upsert_memory,
            memory_cmd::delete_memory,
            memory_cmd::toggle_memory,
            // Documents
            documents_cmd::list_documents,
            documents_cmd::upsert_document,
            documents_cmd::delete_document,
            // Attachments
            attachments_cmd::add_attachment,
            attachments_cmd::get_attachment_data,
            attachments_cmd::delete_attachment,
            // Search
            search_cmd::get_search_config,
            search_cmd::set_search_config,
            search_cmd::web_search,
            // Compare
            compare_cmd::run_compare,
            compare_cmd::cancel_compare,
            compare_cmd::save_compare_winner,
            // Slash commands
            slash_cmd::list_slash_commands,
            slash_cmd::upsert_slash_command,
            slash_cmd::delete_slash_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
