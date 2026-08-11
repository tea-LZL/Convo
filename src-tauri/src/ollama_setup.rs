use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub version: String,
}

#[derive(Debug, Deserialize)]
struct VersionResponse {
    version: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PullProgress {
    pub status: String,
    pub digest: String,
    pub total: u64,
    pub completed: u64,
    pub percent: f64,
}

#[derive(Debug, Deserialize)]
struct PullChunk {
    pub status: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub completed: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LibraryModel {
    pub name: String,
    pub description: String,
    pub size: String,
    #[serde(default)]
    pub macos_only: bool,
    #[serde(default)]
    pub pull_count: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[tauri::command]
pub fn get_model_catalog() -> Vec<LibraryModel> {
    vec![
        LibraryModel {
            name: "deepseek-r1:1.5b".to_string(),
            description: "Ultra-lightweight reasoning. Runs on any device including phones. Fast responses but limited reasoning depth. Good for simple logic tasks.".to_string(),
            size: "1.1GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:7b".to_string(),
            description: "Compact reasoning model. Runs on 8GB RAM laptops. Decent chain-of-thought for everyday tasks. Best entry point for R1 on consumer hardware.".to_string(),
            size: "4.7GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:8b".to_string(),
            description: "Similar to 7B, slightly stronger. Runs on 8GB RAM. Good balance of speed and reasoning quality for daily use.".to_string(),
            size: "5.2GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:14b".to_string(),
            description: "Sweet spot for reasoning on consumer hardware. Needs ~10GB VRAM. Significantly better logic and math than 7/8B while still fast enough for interactive use.".to_string(),
            size: "9.0GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:32b".to_string(),
            description: "Strong reasoning for desktop GPUs (24GB VRAM). Handles complex multi-step problems well. Slower than smaller models but much more capable.".to_string(),
            size: "20GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:70b".to_string(),
            description: "Powerful reasoning. Requires high-end GPU (48GB+ VRAM) or Apple Silicon. Excellent for deep analysis but noticeably slower.".to_string(),
            size: "43GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "deepseek-r1:671b".to_string(),
            description: "Maximum reasoning power (MoE). Needs multi-GPU setup or cloud. Not recommended for local use unless you have enterprise hardware.".to_string(),
            size: "404GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:0.8b".to_string(),
            description: "Tiny model, runs anywhere. Very fast but limited capability. Good for testing or extremely constrained devices.".to_string(),
            size: "1.0GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:2b".to_string(),
            description: "Lightweight multimodal. Runs on 4GB RAM devices. Handles basic text and image tasks. Good for low-end hardware.".to_string(),
            size: "2.7GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:4b".to_string(),
            description: "Compact and practical. Runs on 6GB RAM. Decent quality for chat, summarization, and simple image understanding. Recommended minimum for useful work.".to_string(),
            size: "3.4GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:9b".to_string(),
            description: "Best all-rounder for consumer hardware. Needs ~8GB VRAM. Strong text and image capabilities with good speed. Recommended for most users.".to_string(),
            size: "6.6GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:27b".to_string(),
            description: "High quality multimodal. Needs 16-24GB VRAM. Excellent reasoning and image understanding. Best choice if your GPU can handle it.".to_string(),
            size: "17GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:35b".to_string(),
            description: "Advanced capabilities. Needs 24GB+ VRAM. Very strong across all tasks but slower. For high-end desktop GPUs.".to_string(),
            size: "24GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.5:122b".to_string(),
            description: "Maximum capability. Needs 80GB+ VRAM or multi-GPU. Not practical for most local setups.".to_string(),
            size: "81GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:27b".to_string(),
            description: "Strong multimodal with improved coding. Needs 16-24GB VRAM. Better than Qwen 3.5 at code generation and agentic tasks. Recommended for developers with capable GPUs.".to_string(),
            size: "17GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:35b".to_string(),
            description: "Advanced coding and reasoning. Needs 24GB+ VRAM. Best overall Qwen 3.6 for local use if hardware allows. Excellent for coding workflows and complex tasks.".to_string(),
            size: "24GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:27b-coding-mxfp8".to_string(),
            description: "MLX coding-optimized (Apple Silicon). Enhanced for code tasks with MXFP8 quantization. Good for Mac users focused on coding.".to_string(),
            size: "31GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:27b-coding-nvfp4".to_string(),
            description: "MLX coding-optimized (Apple Silicon). Most memory-efficient coding variant for Mac. Best for Macs with limited RAM.".to_string(),
            size: "20GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:27b-coding-bf16".to_string(),
            description: "MLX coding-optimized full precision (Apple Silicon). Maximum coding quality for Mac. Needs M-series with 64GB+ unified memory.".to_string(),
            size: "55GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:27b-mlx-bf16".to_string(),
            description: "MLX full precision (Apple Silicon). General-purpose high quality for Mac. Needs M-series with 64GB+ unified memory.".to_string(),
            size: "55GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:35b-a3b-coding-mxfp8".to_string(),
            description: "MLX coding-optimized, 35B with 3B active (MoE). Efficient coding model for Mac. Good balance of quality and speed.".to_string(),
            size: "38GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:35b-a3b-coding-nvfp4".to_string(),
            description: "MLX coding-optimized, 35B with 3B active (MoE). Most efficient 35B coding variant for Mac. Recommended for Mac developers.".to_string(),
            size: "22GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:35b-a3b-coding-bf16".to_string(),
            description: "MLX coding full precision (MoE). Maximum coding quality for Mac. Needs M-series with 128GB unified memory.".to_string(),
            size: "70GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "qwen3.6:35b-a3b-mlx-bf16".to_string(),
            description: "MLX full precision general (MoE). Maximum general quality for Mac. Needs M-series with 128GB unified memory.".to_string(),
            size: "70GB".to_string(),
            macos_only: true,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string()]),
        },
        LibraryModel {
            name: "gemma4:e2b".to_string(),
            description: "Expert 2B MoE model. Very efficient, runs on most laptops. Good for lightweight tasks and quick responses. Recommended for low-end hardware.".to_string(),
            size: "7.2GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string()]),
        },
        LibraryModel {
            name: "gemma4:e4b".to_string(),
            description: "Expert 4B MoE model. Better quality than e2b while still very efficient. Runs on 8GB RAM. Recommended starting point for Gemma 4.".to_string(),
            size: "9.6GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string()]),
        },
        LibraryModel {
            name: "gemma4:26b".to_string(),
            description: "Strong multimodal. Needs 16-24GB VRAM. Excellent text and image understanding. Best Gemma 4 for consumer GPUs.".to_string(),
            size: "18GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string(), "audio".to_string()]),
        },
        LibraryModel {
            name: "gemma4:31b".to_string(),
            description: "High-end multimodal. Needs 24GB VRAM. Best overall Gemma 4 quality. Recommended if your GPU has enough memory.".to_string(),
            size: "20GB".to_string(),
            macos_only: false,
            pull_count: None,
            tags: Some(vec!["vision".to_string(), "tools".to_string(), "thinking".to_string(), "audio".to_string()]),
        },
    ]
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<crate::db::models::OllamaModel>, String> {
    crate::providers::ollama::fetch_models("http://localhost:11434").await
}

#[tauri::command]
pub async fn get_model_context_length(model: String) -> Result<u32, String> {
    crate::providers::ollama::fetch_context_length("http://localhost:11434", &model).await
}

#[tauri::command]
pub async fn get_running_models() -> Result<Vec<crate::db::models::RunningModel>, String> {
    crate::providers::ollama::fetch_running_models("http://localhost:11434").await
}

#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://localhost:11434/api/version")
        .send()
        .await;

    match resp {
        Ok(r) => {
            let body: VersionResponse = r
                .json()
                .await
                .map_err(|e| format!("Failed to parse version: {}", e))?;
            Ok(OllamaStatus {
                installed: true,
                running: true,
                version: body.version,
            })
        }
        Err(e) => {
            let err = e.to_string();
            if err.contains("connection") || err.contains("refused") {
                Ok(OllamaStatus {
                    installed: false,
                    running: false,
                    version: String::new(),
                })
            } else {
                Err(err)
            }
        }
    }
}

#[tauri::command]
pub async fn pull_model(app: AppHandle, name: String) -> Result<(), String> {
    let app_clone = app.clone();
    let name_clone = name.clone();

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let resp = match client
            .post("http://localhost:11434/api/pull")
            .json(&serde_json::json!({ "name": &name_clone }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let _ = app_clone.emit("pull-error", &e.to_string());
                return;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let err = format!("Ollama error {}: {}", status, body);
            let _ = app_clone.emit("pull-error", &err);
            return;
        }

        let mut buffer = String::new();
        let mut stream = resp.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    let err = format!("Stream error: {}", e);
                    let _ = app_clone.emit("pull-error", &err);
                    return;
                }
            };

            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                match serde_json::from_str::<PullChunk>(&line) {
                    Ok(chunk) => {
                        if chunk.status == "success" {
                            let _ = app_clone.emit("pull-done", &name_clone);
                            return;
                        }

                        let progress = PullProgress {
                            status: chunk.status.clone(),
                            digest: chunk.digest.clone().unwrap_or_default(),
                            total: chunk.total.unwrap_or(0),
                            completed: chunk.completed.unwrap_or(0),
                            percent: if let (Some(total), Some(completed)) =
                                (chunk.total, chunk.completed)
                            {
                                if total > 0 {
                                    (completed as f64 / total as f64) * 100.0
                                } else {
                                    0.0
                                }
                            } else {
                                0.0
                            },
                        };

                        let _ = app_clone.emit("pull-progress", &progress);
                    }
                    Err(e) => {
                        let err = format!(
                            "Failed to parse: {} (line: {})",
                            e,
                            &line[..line.len().min(100)]
                        );
                        let _ = app_clone.emit("pull-error", &err);
                        return;
                    }
                }
            }
        }

        let _ = app_clone.emit("pull-done", &name_clone);
    });

    Ok(())
}

#[tauri::command]
pub async fn delete_model(app: AppHandle, name: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .delete("http://localhost:11434/api/delete")
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, body));
    }

    let _ = app.emit("delete-done", &name);
    Ok(())
}

#[tauri::command]
pub async fn create_custom_model(
    app: AppHandle,
    name: String,
    base_model: String,
    num_ctx: u32,
) -> Result<(), String> {
    let modelfile = format!("FROM {}\nPARAMETER num_ctx {}\n", base_model, num_ctx);

    let safe_name = name.replace([':', '/', '\\'], "_");
    let modelfile_path = std::env::temp_dir().join(format!("convo_mf_{}.txt", safe_name));

    std::fs::write(&modelfile_path, &modelfile)
        .map_err(|e| format!("Failed to write modelfile: {}", e))?;

    let _ = app.emit("create-progress", "Creating model...");

    let path_str = modelfile_path.to_str().unwrap_or("").to_string();
    let name_clone = name.clone();

    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("ollama")
            .args(["create", &name_clone, "-f", &path_str])
            .output()
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| format!("Failed to run ollama create: {}", e))?;

    let _ = std::fs::remove_file(&modelfile_path);

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("Ollama create failed: {}", msg));
    }

    let _ = app.emit("create-done", &name);
    Ok(())
}
