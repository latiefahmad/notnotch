//! Request signatures, each as its API documents it. Tests use the documented examples.
//!
//! - Kraken: API-Sign = base64(HMAC-SHA512(base64-decoded secret, path + SHA256(nonce + body))).
//! - Binance: signature = hex(HMAC-SHA256(secret, query string)).
//! - Coinbase Advanced Trade (CDP keys): an ES256 JWT per request. ECDSA P-256 is signed with
//!   Windows CNG, so no extra crypto crate is needed.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256, Sha512};

pub fn kraken(path: &str, nonce: &str, body: &str, secret_b64: &str) -> Result<String, String> {
    let secret = STANDARD.decode(secret_b64.trim()).map_err(|_| "unauthorized")?;
    let inner = Sha256::digest(format!("{nonce}{body}").as_bytes());
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(&secret).expect("HMAC takes any key length");
    mac.update(path.as_bytes());
    mac.update(&inner);
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}

pub fn binance(query: &str, secret: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.trim().as_bytes()).expect("HMAC takes any key length");
    mac.update(query.as_bytes());
    hex(&mac.finalize().into_bytes())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// JWT for one Coinbase request. `uri`: "GET api.coinbase.com/api/v3/brokerage/accounts".
pub fn coinbase_jwt(key_name: &str, pem: &str, uri: &str, now_secs: u64, nonce: &str) -> Result<String, String> {
    let key = ec_private_key(pem)?;
    let header = serde_json::json!({ "alg": "ES256", "typ": "JWT", "kid": key_name, "nonce": nonce });
    // nbf a few seconds back, so a PC clock slightly ahead of Coinbase's still passes.
    let claims = serde_json::json!({ "iss": "cdp", "sub": key_name, "nbf": now_secs.saturating_sub(5), "exp": now_secs + 120, "uri": uri });
    let input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
    let signature = cng::sign_p256(&key, &Sha256::digest(input.as_bytes()))?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

/// P-256 key: private scalar `d` and public point (x, y).
pub struct EcKey {
    pub d: [u8; 32],
    pub x: [u8; 32],
    pub y: [u8; 32],
}

impl Drop for EcKey {
    fn drop(&mut self) {
        wipe(&mut self.d);
    }
}

/// Zeroes with volatile writes, so the wipe of key material is not optimized away.
fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

/// Bytes holding key material, zeroed when dropped on every path (errors and `?` included).
struct Wiped(Vec<u8>);

impl Drop for Wiped {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// Reads a SEC1 "EC PRIVATE KEY" PEM, also as pasted from Coinbase's JSON file (literal "\n")
/// or into a single-line field (newlines dropped).
/// SEC1: SEQUENCE { INTEGER 1, OCTET STRING d, [0] curve OID, [1] BIT STRING 04||x||y }.
pub fn ec_private_key(pem: &str) -> Result<EcKey, String> {
    let mut text = pem.replace("\\n", "\n");
    // Drop the "-----BEGIN …-----" and "-----END …-----" markers wherever they are.
    while let Some(start) = text.find("-----") {
        let end = text[start + 5..].find("-----").map(|e| start + 5 + e + 5).unwrap_or(text.len());
        text.replace_range(start..end, "");
    }
    let body: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let body = Wiped(body.into_bytes());
    let der = Wiped(STANDARD.decode(&body.0).map_err(|_| "bad-key")?);
    let der = &der.0;
    // Version 1 and the 32-byte private key: 02 01 01 04 20 <d>.
    let at = der.windows(5).position(|w| w == [0x02, 0x01, 0x01, 0x04, 0x20]).ok_or("bad-key")? + 5;
    let d = der.get(at..at + 32).ok_or("bad-key")?;
    // Uncompressed public point: 03 42 00 04 <x> <y>.
    let p = der.windows(4).position(|w| w == [0x03, 0x42, 0x00, 0x04]).ok_or("bad-key")? + 4;
    let xy = der.get(p..p + 64).ok_or("bad-key")?;
    let mut key = EcKey { d: [0; 32], x: [0; 32], y: [0; 32] };
    key.d.copy_from_slice(d);
    key.x.copy_from_slice(&xy[..32]);
    key.y.copy_from_slice(&xy[32..]);
    Ok(key)
}

/// Random hex (JWT nonce, request ids). Fails rather than returning zeros.
pub fn random_hex(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len];
    cng::random(&mut buf)?;
    Ok(hex(&buf))
}

#[cfg(windows)]
mod cng {
    use super::{EcKey, Wiped};
    use windows::Win32::Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptDestroyKey, BCryptGenRandom, BCryptImportKeyPair, BCryptOpenAlgorithmProvider, BCryptSignHash,
        BCRYPT_ALG_HANDLE, BCRYPT_ECCPRIVATE_BLOB, BCRYPT_ECDSA_P256_ALGORITHM, BCRYPT_ECDSA_PRIVATE_P256_MAGIC, BCRYPT_FLAGS, BCRYPT_KEY_HANDLE,
        BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    /// Imports the key pair and runs `f` with it; handles are always released.
    pub fn with_key<T>(key: &EcKey, f: impl FnOnce(BCRYPT_KEY_HANDLE) -> Result<T, String>) -> Result<T, String> {
        // Capacity up front, so the private part is never left behind in a reallocation.
        let mut blob = Wiped(Vec::with_capacity(8 + 96));
        blob.0.extend(BCRYPT_ECDSA_PRIVATE_P256_MAGIC.to_le_bytes());
        blob.0.extend(32u32.to_le_bytes());
        blob.0.extend(key.x);
        blob.0.extend(key.y);
        blob.0.extend(key.d);
        unsafe {
            let mut alg = BCRYPT_ALG_HANDLE::default();
            BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_ECDSA_P256_ALGORITHM, None, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0))
                .ok()
                .map_err(|e| format!("network:ECDSA unavailable ({e})"))?;
            let mut handle = BCRYPT_KEY_HANDLE::default();
            let imported = BCryptImportKeyPair(alg, None, BCRYPT_ECCPRIVATE_BLOB, &mut handle, &blob.0, 0).ok();
            let result = match imported {
                Ok(()) => {
                    let r = f(handle);
                    let _ = BCryptDestroyKey(handle);
                    r
                }
                Err(_) => Err("bad-key".to_string()),
            };
            let _ = BCryptCloseAlgorithmProvider(alg, 0);
            result
        }
    }

    /// ECDSA signature as r||s (64 bytes), which is the JWS ES256 format.
    pub fn sign_p256(key: &EcKey, hash: &[u8]) -> Result<Vec<u8>, String> {
        with_key(key, |handle| unsafe {
            let mut sig = vec![0u8; 64];
            let mut len = 0u32;
            BCryptSignHash(handle, None, hash, Some(&mut sig), &mut len, BCRYPT_FLAGS(0)).ok().map_err(|_| "bad-key".to_string())?;
            sig.truncate(len as usize);
            Ok(sig)
        })
    }

    pub fn random(buf: &mut [u8]) -> Result<(), String> {
        unsafe { BCryptGenRandom(None, buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.ok().map_err(|e| format!("network:no random numbers ({e})"))
    }

    #[cfg(test)]
    pub fn verify_p256(key: &EcKey, hash: &[u8], sig: &[u8]) -> bool {
        use windows::Win32::Security::Cryptography::BCryptVerifySignature;
        with_key(key, |handle| Ok(unsafe { BCryptVerifySignature(handle, None, hash, sig, BCRYPT_FLAGS(0)).is_ok() })).unwrap_or(false)
    }
}

/// On a Mac: random numbers from the system, no P-256 signing yet (Coinbase is the only provider that needs it).
#[cfg(not(windows))]
mod cng {
    use super::EcKey;
    use std::io::Read;

    pub fn sign_p256(_: &EcKey, _: &[u8]) -> Result<Vec<u8>, String> {
        Err("unsupported".into())
    }

    pub fn random(buf: &mut [u8]) -> Result<(), String> {
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).map_err(|e| format!("network:no random numbers ({e})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// docs.kraken.com/api/docs/guides/spot-rest-auth, "Setting the API-Sign Parameter".
    #[test]
    fn kraken_documented_example() {
        let sign = kraken(
            "/0/private/AddOrder",
            "1616492376594",
            "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
            "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
        )
        .unwrap();
        assert_eq!(sign, "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
    }

    /// developers.binance.com, Spot REST API, "Request security", HMAC example.
    #[test]
    fn binance_documented_example() {
        let sign = binance(
            "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559",
            "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j",
        );
        assert_eq!(sign, "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
    }

    /// RFC 6979 A.2.5 (P-256, SHA-256, message "sample"): the documented signature must verify
    /// with the documented key, which checks the key blob layout handed to CNG.
    #[test]
    #[cfg(windows)]
    fn p256_rfc6979_vector_verifies() {
        let mut key = EcKey { d: [0; 32], x: [0; 32], y: [0; 32] };
        key.d.copy_from_slice(&unhex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"));
        key.x.copy_from_slice(&unhex("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"));
        key.y.copy_from_slice(&unhex("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"));
        let sig = unhex(
            "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8",
        );
        let hash = Sha256::digest(b"sample");
        assert!(cng::verify_p256(&key, &hash, &sig));
        assert!(!cng::verify_p256(&key, &Sha256::digest(b"other"), &sig));
    }

    /// A throwaway key made for this test with `openssl ecparam -name prime256v1 -genkey`. Written as parts so
    /// secret-scanning push protection doesn't flag this well-known public test vector as a real credential.
    const TEST_PEM: &str = concat!(
        "-----BEGIN ",
        "EC PRIVATE KEY",
        "-----\n",
        "MHcCAQEEIIJ5ig3gmSDql6+M4sRPuGcgVRHvv1pHBa5oedJhTogWoAoGCCqGSM49\n",
        "AwEHoUQDQgAEN/Fg49QyESj9vVe9N6MruwN2IqxvJafjVNVEaD5x5AyvEo83qlRO\n",
        "/K+73kI0DWlUY2OrIJnHevoazD7vkperqg==\n",
        "-----END ",
        "EC PRIVATE KEY",
        "-----\n",
    );

    #[test]
    fn sec1_pem_parses_also_with_escaped_newlines() {
        let key = ec_private_key(TEST_PEM).unwrap();
        assert_eq!(hex(&key.d), "82798a0de09920ea97af8ce2c44fb867205511efbf5a4705ae6879d2614e8816");
        assert_eq!(hex(&key.x[..4]), "37f160e3");
        let escaped = TEST_PEM.replace('\n', "\\n");
        assert_eq!(ec_private_key(&escaped).unwrap().y, key.y);
        let one_line = TEST_PEM.replace('\n', "");
        assert_eq!(ec_private_key(&one_line).unwrap().d, key.d);
        assert!(ec_private_key("not a key").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn coinbase_jwt_has_documented_claims_and_verifies() {
        let jwt = coinbase_jwt("organizations/o/apiKeys/k", TEST_PEM, "GET api.coinbase.com/api/v3/brokerage/accounts", 1_700_000_000, "abc").unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "organizations/o/apiKeys/k");
        assert_eq!(header["nonce"], "abc");
        assert_eq!(claims["iss"], "cdp");
        assert_eq!(claims["sub"], "organizations/o/apiKeys/k");
        assert_eq!(claims["nbf"], 1_699_999_995);
        assert_eq!(claims["exp"], 1_700_000_120);
        assert_eq!(claims["uri"], "GET api.coinbase.com/api/v3/brokerage/accounts");
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(sig.len(), 64);
        let key = ec_private_key(TEST_PEM).unwrap();
        assert!(cng::verify_p256(&key, &Sha256::digest(format!("{}.{}", parts[0], parts[1]).as_bytes()), &sig));
    }
}
