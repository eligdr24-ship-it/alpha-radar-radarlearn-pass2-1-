// Wipe the local persistence file. Usage: npm run db:reset
import fs from 'fs';
import path from 'path';
const dir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const file = path.join(dir, 'alpha-radar.json');
if (fs.existsSync(file)) { fs.unlinkSync(file); console.log('removed', file); }
else console.log('nothing to remove at', file);
