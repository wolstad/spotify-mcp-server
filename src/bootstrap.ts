// Side-effect-only entry-point hook. Loading this module evaluates `utils.ts`
// (which defines `loadDotenv`) and then calls `loadDotenv()` before any other
// imports in the host file evaluate, mirroring the ordering guarantee the old
// `import 'dotenv/config'` pattern provided.
import { loadDotenv } from './utils.js';

loadDotenv();
