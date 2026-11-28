//! Cleanup API keys in the macOS Keychain, one generic password per provider
//! (onboarding table rows 16 and 16c). Reads are cached for the process, so
//! settings reads do not hit the Keychain each time. Other platforms have no
//! Keychain here: `set` fails and the key stays in the settings file.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.edkiboma.voce.cleanup-key";

/// provider id -> key (None: looked up, not there).
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn cached<R>(f: impl FnOnce(&mut HashMap<String, Option<String>>) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

pub fn get(provider: &str) -> Option<String> {
    if let Some(hit) = cached(|c| c.get(provider).cloned()) {
        return hit;
    }
    let value = backend::get(provider);
    cached(|c| c.insert(provider.to_string(), value.clone()));
    value
}

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    if cached(|c| c.get(provider).cloned()).flatten().as_deref() == Some(key) {
        return Ok(());
    }
    backend::set(provider, key)?;
    cached(|c| c.insert(provider.to_string(), Some(key.to_string())));
    Ok(())
}

pub fn delete(provider: &str) {
    if get(provider).is_none() {
        return;
    }
    backend::delete(provider);
    cached(|c| c.insert(provider.to_string(), None));
}

#[cfg(all(target_os = "macos", not(test)))]
mod backend {
    use super::SERVICE;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub fn get(provider: &str) -> Option<String> {
        get_generic_password(SERVICE, provider)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|k| !k.is_empty())
    }

    pub fn set(provider: &str, key: &str) -> Result<(), String> {
        set_generic_password(SERVICE, provider, key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(provider: &str) {
        let _ = delete_generic_password(SERVICE, provider);
    }
}

#[cfg(all(not(target_os = "macos"), not(test)))]
mod backend {
    pub fn get(_provider: &str) -> Option<String> {
        None
    }

    pub fn set(_provider: &str, _key: &str) -> Result<(), String> {
        Err("no Keychain on this platform".into())
    }

    pub fn delete(_provider: &str) {}
}

/// Tests never touch the real Keychain: an in-memory one, and providers
/// whose writes fail (row 16c's failed write).
#[cfg(test)]
pub mod backend {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    static STORE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    static FAILING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    pub fn fail_writes_for(provider: &str) {
        FAILING
            .lock()
            .unwrap()
            .get_or_insert_with(HashSet::new)
            .insert(provider.to_string());
    }

    pub fn get(provider: &str) -> Option<String> {
        STORE.lock().unwrap().as_ref()?.get(provider).cloned()
    }

    pub fn set(provider: &str, key: &str) -> Result<(), String> {
        if FAILING
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|f| f.contains(provider))
        {
            return Err("write refused".into());
        }
        STORE
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(provider.to_string(), key.to_string());
        Ok(())
    }

    pub fn delete(provider: &str) {
        if let Some(store) = STORE.lock().unwrap().as_mut() {
            store.remove(provider);
        }
    }
}
