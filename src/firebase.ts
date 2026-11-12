import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

/**
 * PR Times Watcher と同じ Firebase プロジェクト（prtimes-inbox）のウェブアプリの設定値。
 * ブラウザに配られる公開情報なので、リポジトリに置いてよい（読み書きの制限は prtimes-inbox の firestore.rules で行う）。
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyC47E7jrvlXY_XybBfSjRMaFJL2_f7YUDQ',
  authDomain: 'prtimes-inbox.firebaseapp.com',
  projectId: 'prtimes-inbox',
  storageBucket: 'prtimes-inbox.firebasestorage.app',
  messagingSenderId: '723210521199',
  appId: '1:723210521199:web:b1b8ec31e4ca9e17271b9a',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
