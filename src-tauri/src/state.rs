use crate::db::DbPool;
use std::sync::{Arc, OnceLock};

pub struct AppState;

impl AppState {
    pub fn new(_pool: Arc<DbPool>) -> Self {
        Self
    }
}

static POOL: OnceLock<Arc<DbPool>> = OnceLock::new();

pub fn set_pool_static(pool: Arc<DbPool>) {
    let _ = POOL.set(pool);
}

pub fn get_pool_static() -> Option<Arc<DbPool>> {
    POOL.get().cloned()
}
