mod commands;
mod conversation;
mod ollama;
mod setup;
mod streams;

use streams::ActiveStreams;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ActiveStreams::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_models,
            commands::get_model_context_length,
            commands::chat_stream,
            commands::cancel_chat,
            commands::save_conversation_messages,
            commands::list_conversations,
            commands::create_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::get_messages,
            commands::get_conversation,
            commands::get_running_models,
            setup::check_ollama_status,
            setup::get_model_catalog,
            setup::pull_model,
            setup::delete_model,
            setup::create_custom_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
