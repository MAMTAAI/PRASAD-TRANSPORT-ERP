import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// 🚀 आपका असली Firebase Config (जो आपने फोटो में दिखाया है)
const firebaseConfig = {
  apiKey: "AIzaSyBzbSLXzmb0vaQlCZKFuUcJqPLGp_a6Bv8",
  authDomain: "prasad-transport-grup.firebaseapp.com",
  projectId: "prasad-transport-grup",
  storageBucket: "prasad-transport-grup.firebasestorage.app",
  messagingSenderId: "837828662164",
  appId: "1:837828662164:web:e10fbd98e869f009cd3581",
  measurementId: "G-GLLNJPS9M2"
};

// Firebase को चालू करना
const app = initializeApp(firebaseConfig);

// Database (Firestore) को एक्सपोर्ट करना
export const db = getFirestore(app);