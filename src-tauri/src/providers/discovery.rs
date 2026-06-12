use serde::{Deserialize, Serialize};
use std::time::Duration;

pub use crate::services::{DiscoveredModel, DiscoveredServer};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct _LocalPlaceholder {}

/// Probe a list of candidate OpenAI-compatible servers (default port range 8000-8020)
/// and return those that respond with a valid /v1/models endpoint.
pub async fn scan_localhost() -> Vec<DiscoveredServer> {
    let mut found: Vec<DiscoveredServer> = Vec::new();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
        .expect("reqwest client");

    let mut handles = Vec::new();
    for port in 8000u16..=8020 {
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            let base = format!("http://localhost:{}", port);
            let resp = client.get(format!("{}/v1/models", base)).send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    if let Ok(body) = r.json::<serde_json::Value>().await {
                        let models: Vec<DiscoveredModel> = body
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| {
                                        let id = m.get("id").and_then(|v| v.as_str())?;
                                        Some(DiscoveredModel {
                                            id: id.to_string(),
                                            name: id.to_string(),
                                            context_length: None,
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if !models.is_empty() {
                            return Some(DiscoveredServer {
                                base_url: base,
                                kind: "openai_compat".into(),
                                models,
                            });
                        }
                    }
                }
                _ => {}
            }
            None
        }));
    }

    for h in handles {
        if let Ok(Some(s)) = h.await {
            found.push(s);
        }
    }
    found
}
