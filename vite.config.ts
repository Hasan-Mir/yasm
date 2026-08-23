import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import * as packageJson from './package.json';

export default defineConfig({
    plugins: [dts({ rollupTypes: true })],
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'yasm',
            formats: ['es', 'umd'],
            fileName: format => `index.${format}.js`
        },
        rollupOptions: {
            external: [
                ...Object.keys(packageJson.peerDependencies || {}),
                ...Object.keys(packageJson.dependencies || {})
            ],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                    immer: 'immer'
                }
            }
        },
        sourcemap: true
    }
});
