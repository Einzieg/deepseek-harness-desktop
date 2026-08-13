import { defineConfig } from 'tsdown'

/** Build the Electron main-process entry consumed by package.json. */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Electron provides this module only inside its main process. Bundling the
  // npm launcher package would replace the API with an executable path.
  deps: { neverBundle: ['electron'] },
})
