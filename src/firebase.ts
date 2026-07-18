// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// 🔑 आपकी असली Firebase API Keys
const firebaseConfig = {
  apiKey: "AIzaSyBzbSLXzmb0VaQLCZKFuUcJqPLGp_a6Bv8",
  authDomain: "prasad-transport-grup.firebaseapp.com",
  projectId: "prasad-transport-grup",
  storageBucket: "prasad-transport-grup.appspot.com",
  messagingSenderId: "837828662164",
  appId: "1:837828662164:web:e10fbd98e869f009cd3581"
};

// Initialize Firebase (वेबसाइट को फायरबेस से जोड़ना)
const app = initializeApp(firebaseConfig);

// Database और Storage चालू करना
export const db = getFirestore(app);
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
