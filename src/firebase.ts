// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// 🔑 आपकी असली Firebase API Keys
const firebaseConfig = {
  apiKey: "AIzaSyBzbSLXzmbOvaQlCZKFuUcJqPLGp_a6Bv8", // current Browser key (old value was a hand-typed variant rejected by Identity Toolkit)
  authDomain: "prasad-transport-grup.firebaseapp.com",
  projectId: "prasad-transport-grup",
  storageBucket: "prasad-transport-grup.appspot.com",
  messagingSenderId: "837828662164",
  appId: "1:837828662164:web:e10fbd98e869f009cd3581"
};

// Initialize Firebase (वेबसाइट को फायरबेस से जोड़ना)
const app = initializeApp(firebaseConfig);

// Database और Storage चालू करना
// ⚡ Persistent IndexedDB cache: repeat full-collection reads are served
// locally (near-instant warm loads, big Firestore read-cost saving) and
// writes queue automatically when offline. Falls back to memory-only cache
// on browsers that block IndexedDB (private mode).
let _db;
try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (e) {
  console.warn("Persistent cache unavailable — using in-memory Firestore cache", e);
  _db = getFirestore(app);
}
export const db = _db;
export const storage = getStorage(app);
export const auth = getAuth(app);

// 🔐 SECURITY: Firestore/Storage rules now require a signed-in user
// (request.auth != null). Until real per-user Firebase Auth ships (Phase 1),
// every session gets an anonymous auth token so the deployed app keeps working
// while direct anonymous REST access to the database is shut off.
// App-level login (USERS + salted hashes) still decides who sees what.
export const authReady: Promise<void> = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (u) => {
    if (u) {
      unsub();
      resolve();
    } else {
      signInAnonymously(auth).catch((e) => {
        console.error("Anonymous sign-in failed — Firestore access will be blocked by rules:", e);
        unsub();
        resolve();
      });
    }
  });
});
