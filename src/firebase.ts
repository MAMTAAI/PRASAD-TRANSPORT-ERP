// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// 🔑 आपकी असली Firebase API Keys
const firebaseConfig = {
  apiKey: "AIzaSyBzbSLXzmb0VaQLCZKFuUcJqPLGp_a6Bv8",
  authDomain: "prasad-transport-grup.firebaseapp.com",
  projectId: "prasad-transport-grup",
  storageBucket: "prasad-transport-grup.appspot.com",
  messagingSenderId: "837828662164",
  appId: "1:837828662164:web:e10fbd98e869f009cd3581"
};

// Initialize Firebase (वेबसाइट को फायरबेस से जोड़ना)
const app = initializeApp(firebaseConfig);

// Database और Storage चालू करना
export const db = getFirestore(app);
export const storage = getStorage(app);