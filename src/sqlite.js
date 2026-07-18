// Database driver selector.
//
// Prefers better-sqlite3 (fast, ships prebuilt binaries for macOS/Windows/Linux
// and works on Node 18+). If it isn't installed or failed to build, falls back
// to Node's built-in node:sqlite (no compilation, but needs Node >= 22.5 and the
// --experimental-sqlite flag on Node 22.x). Both expose the prepare/run/get/all
// surface this app uses, so the rest of the code doesn't care which one is live.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

let db;
let driver;

try {
  const { default: Database } = await import('better-sqlite3');
  db = new Database(config.dbPath);
  driver = 'better-sqlite3';
} catch (err) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(config.dbPath);
    driver = 'node:sqlite';
  } catch (err2) {
    console.error(
      '\n[db] No SQLite driver available.\n' +
        '     Install dependencies with `npm install` (builds better-sqlite3),\n' +
        '     or run on Node >= 22.5 with: node --experimental-sqlite src/server.js\n'
    );
    throw err2;
  }
}

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
console.log(`[db] driver: ${driver}`);

export { db, driver };
