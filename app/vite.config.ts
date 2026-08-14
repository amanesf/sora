import { defineConfig } from 'vite';

// Project-site GitHub Pages serves this app from /sora/, not the domain root, so
// asset URLs need that prefix baked in at build time.
export default defineConfig({
  base: '/sora/',
});
