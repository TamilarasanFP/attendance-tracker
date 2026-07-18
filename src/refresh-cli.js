// One-off manual refresh from the command line: `npm run refresh`
import { runSync } from './sync.js';

console.log('Starting manual sync...');
runSync().then((r) => {
  console.log('Done:', JSON.stringify(r, null, 2));
  process.exit(0);
}).catch((e) => {
  console.error('Sync failed:', e.message);
  process.exit(1);
});
