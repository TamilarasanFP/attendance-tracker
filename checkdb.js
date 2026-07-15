'use strict';
// Verifies your Supabase config and connectivity. Run: npm run checkdb
require('dotenv').config();
const db = require('./db');

(async () => {
  if (!db.isConfigured()) {
    console.error('✗ Supabase not configured. Copy .env.example to .env and fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  try {
    await db.ping(); // SELECT from employees
    console.log('✓ Connected to Supabase and the "employees" table is reachable.');

    // round-trip test on a throwaway employee
    await db.upsertEmployee('__healthcheck__', 'Health Check');
    const found = await db.findEmployee('__healthcheck__');
    await db.deleteEmployee('__healthcheck__');
    console.log(found && found.name === 'Health Check'
      ? '✓ Read/write to the "employees" table works.'
      : '✗ Wrote a row but could not read it back — check table columns.');

    // storage bucket check
    const testName = '__healthcheck__.jpg';
    await db.uploadPhoto(testName, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const back = await db.downloadPhoto(testName);
    console.log(back && back.length ? `✓ Storage bucket "${db.BUCKET}" upload/download works.`
                                    : `✗ Could not read back from bucket "${db.BUCKET}".`);
    console.log('\nAll good — start the app with:  npm start');
    process.exit(0);
  } catch (err) {
    console.error('✗ Supabase error:', err.message);
    console.error('  Check: SQL from supabase_setup.sql was run, the bucket exists, and the service_role key is correct.');
    process.exit(1);
  }
})();
