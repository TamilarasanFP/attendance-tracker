import cron from 'node-cron';
import { config } from './config.js';
import { runSync } from './sync.js';
import { store } from './store.js';

// Is a given time window active right now? Evaluated in the SERVER's local time
// (UTC on Render). Empty from/to => always active. Supports overnight windows.
export function windowActiveNow(from, to) {
  if (!from || !to) return true;
  const cur = new Date().toTimeString().slice(0, 5); // "HH:MM"
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

// Whether a college's SERVER sync should run right now, per its own setting.
export function collegeSyncActive(c) {
  const mode = c.sync_mode || 'on';
  if (mode === 'off') return false;
  if (mode === 'scheduled') return windowActiveNow(c.sync_from, c.sync_to);
  return true; // 'on'
}

// The colleges whose sync is active right now (used to scope each sync tick).
async function activeSyncCollegeIds() {
  const colleges = await store.listColleges();
  return colleges.filter(collegeSyncActive).map((c) => c.id);
}

export function startScheduler() {
  if (!cron.validate(config.pollCron)) {
    console.error(`[scheduler] invalid POLL_CRON "${config.pollCron}" — auto-poll disabled`);
    return;
  }
  cron.schedule(config.pollCron, async () => {
    try {
      const allowed = await activeSyncCollegeIds();
      if (!allowed.length) return; // no college wants syncing right now
      const r = await runSync({ batch: config.syncBatchSize, allowedCollegeIds: allowed });
      if (r && !r.skipped) console.log('[scheduler] auto-poll done:', JSON.stringify(r));
    } catch (e) {
      console.error('[scheduler] auto-poll failed:', e.message);
    }
  });
  console.log(`[scheduler] auto-poll scheduled: "${config.pollCron}" (batch ${config.syncBatchSize || 'all'}, per-college)`);

  if (config.pollOnStartup) {
    setTimeout(async () => {
      try {
        const allowed = await activeSyncCollegeIds();
        if (!allowed.length) return;
        console.log('[scheduler] running startup sync...');
        const r = await runSync({ batch: config.syncBatchSize, allowedCollegeIds: allowed });
        console.log('[scheduler] startup sync done:', JSON.stringify(r));
      } catch (e) { console.error('[scheduler] startup sync failed:', e.message); }
    }, 4000);
  }
}
