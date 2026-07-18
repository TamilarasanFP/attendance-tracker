// Data-layer selector. Both implementations expose the SAME async API
// (listStudents, saveStudentStats, …), so routes/sync/ingest don't care which
// one is live. Switch with DB_DRIVER=supabase (else local SQLite).
import { config } from './config.js';

const mod = config.dbDriver === 'supabase'
  ? await import('./pgstore.js')
  : await import('./db.js');

export const store = mod;
export const initStore = mod.initStore || (async () => {});
