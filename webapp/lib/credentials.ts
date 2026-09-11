// lib/credentials.ts
//
// Client-side storage for the user's own WCL API client (Client ID +
// Secret). IndexedDB instead of cookies/localStorage -- structured storage
// that isn't sent to the server on every request the way a cookie would be
// (we send it explicitly, only to our own /api routes). Never leaves the
// browser except in that one request.
"use client";

const DB_NAME = "queue-analyzer";
const DB_VERSION = 1;
const STORE_NAME = "credentials";
const KEY = "wcl";

export interface WclCredentials {
  clientId: string;
  clientSecret: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadCredentials(): Promise<WclCredentials | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(KEY);
    req.onsuccess = () => resolve((req.result as WclCredentials) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCredentials(creds: WclCredentials): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(creds, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCredentials(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
