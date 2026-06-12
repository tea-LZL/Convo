use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HardwareReport {
    pub os: String,
    pub arch: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelFit {
    pub name: String,
    pub family: String,
    pub size_label: String,
    pub fits: bool,
    pub reason: String,
    pub recommended_quant: Option<String>,
}

#[tauri::command]
pub fn get_hardware() -> HardwareReport {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let mut gpus: Vec<GpuInfo> = Vec::new();

    // NVIDIA via nvidia-smi if available
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if parts.len() >= 2 {
                    let name = parts[0].to_string();
                    let total_mb: Option<u64> = parts.get(1).and_then(|s| s.parse().ok());
                    gpus.push(GpuInfo {
                        name,
                        vendor: "NVIDIA".to_string(),
                        vram_bytes: total_mb.map(|mb| mb * 1024 * 1024),
                    });
                }
            }
        }
    }
    // Apple GPU detection
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-json"])
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(arr) = json.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
                        for d in arr {
                            let name = d.get("spdisplays_vendor")
                                .and_then(|v| v.as_str())
                                .or_else(|| d.get("spdisplays_device_name").and_then(|v| v.as_str()))
                                .unwrap_or("Apple GPU")
                                .to_string();
                            let vram = d.get("spdisplays_vram")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.split_whitespace().next())
                                .and_then(|s| s.parse::<u64>().ok())
                                .map(|mb| mb * 1024 * 1024)
                                .or_else(|| d.get("spdisplays_vram_shared").and_then(|v| v.as_str()).map(|_| 0));
                            gpus.push(GpuInfo {
                                name,
                                vendor: "Apple".to_string(),
                                vram_bytes: vram,
                            });
                        }
                    }
                }
            }
        }
    }
    // AMD GPU detection via rocm-smi
    if let Ok(out) = std::process::Command::new("rocm-smi")
        .args(["--showmeminfo", "vram", "--csv"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines().skip(1) {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 4 {
                    let vram_bytes: Option<u64> = parts.get(3)
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .map(|b| b * 1024 * 1024);
                    gpus.push(GpuInfo {
                        name: parts.get(0).unwrap_or(&"AMD GPU").to_string(),
                        vendor: "AMD".to_string(),
                        vram_bytes,
                    });
                }
            }
        }
    }

    HardwareReport {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_brand: sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
        cpu_cores: sys.cpus().len(),
        total_memory_bytes: sys.total_memory(),
        available_memory_bytes: sys.available_memory(),
        gpus,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FitReport {
    pub ram_bytes: u64,
    pub vram_bytes: u64,
    pub fits: Vec<ModelFit>,
    pub partial: Vec<ModelFit>,
    pub too_big: Vec<ModelFit>,
}

/// Recommend whether a curated set of model sizes fits the user's hardware.
/// We don't query Ollama — we use static assumptions about parameter count
/// from the model size label (e.g. "7B" → 7B params).
#[tauri::command]
pub fn recommend_models(hw: HardwareReport) -> FitReport {
    // Map each curated entry to (label, family, params, recommended_quant, min_ram_gb, min_vram_gb_if_gpu)
    let catalog: Vec<(&str, &str, f64, &str, f64, f64)> = vec![
        ("DeepSeek R1 1.5B", "deepseek", 1.5, "Q4_K_M", 4.0, 2.0),
        ("DeepSeek R1 7B", "deepseek", 7.0, "Q4_K_M", 8.0, 5.0),
        ("DeepSeek R1 14B", "deepseek", 14.0, "Q4_K_M", 12.0, 10.0),
        ("DeepSeek R1 32B", "deepseek", 32.0, "Q4_K_M", 24.0, 22.0),
        ("DeepSeek R1 70B", "deepseek", 70.0, "Q4_K_M", 48.0, 44.0),
        ("Qwen 2.5 4B", "qwen", 4.0, "Q4_K_M", 6.0, 3.0),
        ("Qwen 2.5 9B", "qwen", 9.0, "Q4_K_M", 10.0, 7.0),
        ("Qwen 2.5 27B", "qwen", 27.0, "Q4_K_M", 20.0, 18.0),
        ("Qwen 2.5 72B", "qwen", 72.0, "Q4_K_M", 48.0, 44.0),
        ("Gemma 3 4B", "gemma", 4.0, "Q4_K_M", 6.0, 3.0),
        ("Gemma 3 27B", "gemma", 27.0, "Q4_K_M", 20.0, 18.0),
        ("Llama 3.1 8B", "llama", 8.0, "Q4_K_M", 10.0, 6.0),
        ("Llama 3.1 70B", "llama", 70.0, "Q4_K_M", 48.0, 44.0),
        ("Phi-3 3.8B", "phi", 3.8, "Q4_K_M", 6.0, 3.0),
        ("Mistral 7B", "mistral", 7.0, "Q4_K_M", 8.0, 5.0),
    ];

    let total_ram_gb = hw.total_memory_bytes as f64 / 1_073_741_824.0;
    let total_vram_gb: f64 = hw.gpus.iter()
        .filter_map(|g| g.vram_bytes)
        .map(|b| b as f64 / 1_073_741_824.0)
        .sum();

    let mut fits: Vec<ModelFit> = Vec::new();
    let mut partial: Vec<ModelFit> = Vec::new();
    let mut too_big: Vec<ModelFit> = Vec::new();

    for (name, family, params, quant, min_ram, min_vram) in catalog {
        // If a GPU is available with enough VRAM, prefer that. Otherwise RAM.
        let use_gpu = total_vram_gb > 0.0;
        let available = if use_gpu { total_vram_gb } else { total_ram_gb };
        let required = if use_gpu { min_vram } else { min_ram };

        let size_label = if params >= 1.0 {
            format!("{:.0}B", params)
        } else {
            format!("{:.1}B", params)
        };

        if available >= required * 1.3 {
            fits.push(ModelFit {
                name: name.to_string(),
                family: family.to_string(),
                size_label,
                fits: true,
                reason: if use_gpu {
                    format!("Has {:.0} GB VRAM across GPUs", total_vram_gb)
                } else {
                    format!("Has {:.0} GB RAM", total_ram_gb)
                },
                recommended_quant: Some(quant.to_string()),
            });
        } else if available >= required {
            partial.push(ModelFit {
                name: name.to_string(),
                family: family.to_string(),
                size_label,
                fits: false,
                reason: format!("Tight fit: need ~{:.0} GB, have {:.0} GB", required, available),
                recommended_quant: Some(quant.to_string()),
            });
        } else {
            too_big.push(ModelFit {
                name: name.to_string(),
                family: family.to_string(),
                size_label,
                fits: false,
                reason: format!("Need ~{:.0} GB, have {:.0} GB", required, available),
                recommended_quant: None,
            });
        }
    }

    FitReport {
        ram_bytes: hw.total_memory_bytes,
        vram_bytes: (total_vram_gb * 1_073_741_824.0) as u64,
        fits,
        partial,
        too_big,
    }
}
