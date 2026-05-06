#!/usr/bin/env node
import './bootstrap.js';

import { authorizeSpotify } from './utils.js';

console.error('Starting Spotify authentication flow…');
authorizeSpotify()
  .then(() => {
    console.error('Authentication completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Authentication failed:', error);
    process.exit(1);
  });
