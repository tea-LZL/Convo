use crate::db::models::SearchConfig;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct SearchConfigView {
    pub provider: String,
    pub base_url: Option<String>,
    pub has_api_key: bool,
    pub max_results: i64,
}

#[derive(Debug, Deserialize)]
pub struct SearchConfigInput {
    pub provider: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_results: i64,
}

#[tauri::command]
pub fn get_search_config(pool: State<'_, Arc<DbPool>>) -> Result<Option<SearchConfigView>, String> {
    crate::services::migrate_search_api_key(pool.inner().as_ref())?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let r: Result<(String, Option<String>, i64), _> = conn.query_row(
        "SELECT provider, base_url, max_results FROM search_config WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    match r {
        Ok((provider, base_url, max_results)) => Ok(Some(SearchConfigView {
            provider,
            base_url,
            has_api_key: crate::services::get_api_key("search").is_some(),
            max_results,
        })),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn set_search_config(
    pool: State<'_, Arc<DbPool>>,
    config: SearchConfigInput,
) -> Result<(), String> {
    validate_search_config(&config)?;
    if let Some(key) = config.api_key.as_deref() {
        if key.trim().is_empty() {
            crate::services::delete_api_key("search")?;
        } else {
            crate::services::store_api_key("search", key.trim())?;
        }
    }
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO search_config (id, provider, base_url, api_key, max_results)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url, api_key = excluded.api_key, max_results = excluded.max_results",
        params![config.provider, config.base_url, Option::<String>::None, config.max_results],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn web_search(
    query: String,
    config: Option<SearchConfig>,
) -> Result<Vec<SearchResult>, String> {
    let cfg = config.ok_or_else(|| "No search provider configured".to_string())?;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 Convo/0.4")
        .build()
        .map_err(|e| e.to_string())?;
    let max = cfg.max_results.clamp(1, 20) as usize;

    match cfg.provider.as_str() {
        "duckduckgo" => ddg_search(&client, &query, max).await,
        "searxng" => {
            let base = cfg
                .base_url
                .ok_or_else(|| "SearXNG base URL required".to_string())?;
            searxng_search(&client, &base, &query, max).await
        }
        "brave" => {
            let key = crate::services::get_api_key("search")
                .or(cfg.api_key)
                .ok_or_else(|| "Brave API key required".to_string())?;
            brave_search(&client, &key, &query, max).await
        }
        other => Err(format!("Unknown search provider: {}", other)),
    }
}

fn validate_search_config(config: &SearchConfigInput) -> Result<(), String> {
    if !matches!(config.provider.as_str(), "duckduckgo" | "searxng" | "brave") {
        return Err(format!("Unknown search provider: {}", config.provider));
    }
    if config.provider == "searxng"
        && config
            .base_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("SearXNG base URL required".into());
    }
    if !(1..=20).contains(&config.max_results) {
        return Err("Maximum results must be between 1 and 20".into());
    }
    Ok(())
}

async fn ddg_search(
    client: &reqwest::Client,
    query: &str,
    max: usize,
) -> Result<Vec<SearchResult>, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("DuckDuckGo returned HTTP {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let results = parse_ddg_html(&html, max);
    Ok(results)
}

fn parse_ddg_html(html: &str, max: usize) -> Vec<SearchResult> {
    // Lightweight HTML scrape of DuckDuckGo's results page.
    let mut out: Vec<SearchResult> = Vec::new();
    let mut search = 0usize;
    let anchor_marker = "<a rel=\"nofollow\" class=\"result__a\" href=\"";
    let snippet_marker = "class=\"result__snippet\"";
    while out.len() < max {
        let Some(a_pos) = html[search..].find(anchor_marker) else {
            break;
        };
        let abs_a = search + a_pos + anchor_marker.len();
        let Some(href_end_rel) = html[abs_a..].find('"') else {
            break;
        };
        let href = html[abs_a..abs_a + href_end_rel].to_string();
        // Title is between `>` and `</a>`
        let Some(gt_rel) = html[abs_a..].find('>') else {
            break;
        };
        let title_start = abs_a + gt_rel + 1;
        let Some(title_end_rel) = html[title_start..].find("</a>") else {
            break;
        };
        let title = strip_tags(&html[title_start..title_start + title_end_rel]);
        // Snippet follows
        let after = title_start + title_end_rel;
        let snippet = if let Some(sn) = html[after..].find(snippet_marker) {
            let sn_start = after + sn + snippet_marker.len();
            let sn_end = html[sn_start..]
                .find("</a>")
                .or_else(|| html[sn_start..].find("</div>"))
                .unwrap_or(200);
            strip_tags(&html[sn_start..sn_start + sn_end.min(400)])
        } else {
            String::new()
        };
        if !title.is_empty() {
            out.push(SearchResult {
                title,
                url: href,
                snippet,
            });
        }
        search = after + 4;
    }
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

async fn searxng_search(
    client: &reqwest::Client,
    base: &str,
    query: &str,
    max: usize,
) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "{}/search?q={}&format=json&language=en",
        base.trim_end_matches('/'),
        urlencoding(query)
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("SearXNG returned HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = body
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "SearXNG response did not contain results".to_string())?
        .clone();
    Ok(arr
        .into_iter()
        .take(max)
        .filter_map(|v| {
            let title = v.get("title").and_then(|x| x.as_str())?.to_string();
            let url = v.get("url").and_then(|x| x.as_str())?.to_string();
            let snippet = v
                .get("content")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            Some(SearchResult {
                title,
                url,
                snippet,
            })
        })
        .collect())
}

async fn brave_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    max: usize,
) -> Result<Vec<SearchResult>, String> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencoding(query),
        max
    );
    let resp = client
        .get(&url)
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Brave Search returned HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = body
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .ok_or_else(|| "Brave response did not contain web results".to_string())?
        .clone();
    Ok(arr
        .into_iter()
        .filter_map(|v| {
            let title = v.get("title").and_then(|x| x.as_str())?.to_string();
            let url = v.get("url").and_then(|x| x.as_str())?.to_string();
            let snippet = v
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            Some(SearchResult {
                title,
                url,
                snippet,
            })
        })
        .collect())
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                vec![b as char]
            } else {
                format!("%{:02X}", b).chars().collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{parse_ddg_html, urlencoding, validate_search_config, SearchConfigInput};

    #[test]
    fn parses_duckduckgo_results_and_encodes_queries() {
        let html = r#"<a rel="nofollow" class="result__a" href="https://example.test">Title</a><a class="result__snippet">Snippet</a>"#;
        assert_eq!(parse_ddg_html(html, 5)[0].title, "Title");
        assert_eq!(urlencoding("hello world"), "hello%20world");
    }

    #[test]
    fn validates_search_provider_configuration() {
        let valid = SearchConfigInput {
            provider: "brave".into(),
            base_url: None,
            api_key: Some("key".into()),
            max_results: 5,
        };
        assert!(validate_search_config(&valid).is_ok());
        let invalid = SearchConfigInput {
            provider: "searxng".into(),
            base_url: None,
            api_key: None,
            max_results: 5,
        };
        assert!(validate_search_config(&invalid).is_err());
    }
}
