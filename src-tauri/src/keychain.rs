//! Cleanup API keys in the macOS Keychain, one generic password per provider
//! (onboarding table rows 16 and 16c). Reads are cached for the process, so
//! settings reads do not hit the Keychain each time. Other platforms have no
//! Keychain here: `set` fails and the key stays in the settings file.
//!
//! The Keychain service comes from the app's bundle identifier (`service`),
//! so a test build with its own identifier never reads, writes or migrates
//! the keys of the installed app.

use std::collections::HashMap;
use std::sync::Mutex;

/// The Keychain service holding the cleanup keys of the app `identifier`:
/// `com.edkiboma.voce` keeps `com.edkiboma.voce.cleanup-key`.
pub fn service(identifier: &str) -> String {
    format!("{identifier}.cleanup-key")
}

/// (service, provider id) -> key (None: looked up, not there).
type Cache = HashMap<(String, String), Option<String>>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn cached<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn slot(identifier: &str, provider: &str) -> (String, String) {
    (service(identifier), provider.to_string())
}

pub fn get(identifier: &str, provider: &str) -> Option<String> {
    let at = slot(identifier, provider);
    if let Some(hit) = cached(|c| c.get(&at).cloned()) {
        return hit;
    }
    let value = backend::get(&at.0, provider);
    cached(|c| c.insert(at, value.clone()));
    value
}

pub fn set(identifier: &str, provider: &str, key: &str) -> Result<(), String> {
    let at = slot(identifier, provider);
    if cached(|c| c.get(&at).cloned()).flatten().as_deref() == Some(key) {
        return Ok(());
    }
    backend::set(&at.0, provider, key)?;
    cached(|c| c.insert(at, Some(key.to_string())));
    Ok(())
}

pub fn delete(identifier: &str, provider: &str) {
    if get(identifier, provider).is_none() {
        return;
    }
    let at = slot(identifier, provider);
    backend::delete(&at.0, provider);
    cached(|c| c.insert(at, None));
}

#[cfg(all(target_os = "macos", not(test)))]
mod backend {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub fn get(service: &str, provider: &str) -> Option<String> {
        get_generic_password(service, provider)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|k| !k.is_empty())
    }

    pub fn set(service: &str, provider: &str, key: &str) -> Result<(), String> {
        set_generic_password(service, provider, key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, provider: &str) {
        let _ = delete_generic_password(service, provider);
    }
}

#[cfg(all(not(target_os = "macos"), not(test)))]
mod backend {
    pub fn get(_service: &str, _provider: &str) -> Option<String> {
        None
    }

    pub fn set(_service: &str, _provider: &str, _key: &str) -> Result<(), String> {
        Err("no Keychain on this platform".into())
    }

    pub fn delete(_service: &str, _provider: &str) {}
}

/// Tests never touch the real Keychain: an in-memory one, and providers
/// whose writes fail (row 16c's failed write).
#[cfg(test)]
pub mod backend {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
    static FAILING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    pub fn fail_writes_for(provider: &str) {
        FAILING
            .lock()
            .unwrap()
            .get_or_insert_with(HashSet::new)
            .insert(provider.to_string());
    }

    fn at(service: &str, provider: &str) -> (String, String) {
        (service.to_string(), provider.to_string())
    }

    pub fn get(service: &str, provider: &str) -> Option<String> {
        STORE
            .lock()
            .unwrap()
            .as_ref()?
            .get(&at(service, provider))
            .cloned()
    }

    pub fn set(service: &str, provider: &str, key: &str) -> Result<(), String> {
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
            .insert(at(service, provider), key.to_string());
        Ok(())
    }

    pub fn delete(service: &str, provider: &str) {
        if let Some(store) = STORE.lock().unwrap().as_mut() {
            store.remove(&at(service, provider));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_identifier_has_its_own_service_and_the_app_keeps_its_name() {
        assert_eq!(
            service("com.edkiboma.voce"),
            "com.edkiboma.voce.cleanup-key"
        );
        assert_ne!(
            service("com.edkiboma.voce"),
            service("com.edkiboma.voce.publictest")
        );
        // A test build never sees, or deletes, the installed app's key.
        set("com.edkiboma.voce", "keychain-test-provider", "sk-real").unwrap();
        assert_eq!(
            get("com.edkiboma.voce.publictest", "keychain-test-provider"),
            None
        );
        delete("com.edkiboma.voce.publictest", "keychain-test-provider");
        assert_eq!(
            get("com.edkiboma.voce", "keychain-test-provider").as_deref(),
            Some("sk-real")
        );
    }
}
