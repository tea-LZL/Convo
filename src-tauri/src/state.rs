use crate::db::DbPool;
use crate::providers::Provider;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub struct AppState {
    pub pool: Arc<DbPool>,
    pub providers: Mutex<HashMap<String, Arc<dyn Provider>>>,
}

impl AppState {
    pub fn new(pool: Arc<DbPool>) -> Self {
        Self {
            pool,
            providers: Mutex::new(HashMap::new()),
        }
    }

    pub fn register_provider(&self, id: &str, p: Arc<dyn Provider>) {
        if let Ok(mut map) = self.providers.lock() {
            map.insert(id.to_string(), p);
        }
    }

    pub fn get_provider(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.lock().ok().and_then(|m| m.get(id).cloned())
    }

    pub fn list_provider_ids(&self) -> Vec<String> {
        self.providers
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }
}

static POOL: OnceLock<Arc<DbPool>> = OnceLock::new();

pub fn set_pool_static(pool: Arc<DbPool>) {
    let _ = POOL.set(pool);
}

pub fn get_pool_static() -> Option<Arc<DbPool>> {
    POOL.get().cloned()
}
