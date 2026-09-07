import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: {
    alias: {
      '@gerald/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@gerald/config': resolve(__dirname, 'packages/config/src/index.ts'),
      '@gerald/security': resolve(__dirname, 'packages/security/src/index.ts'),
      '@gerald/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@gerald/policy': resolve(__dirname, 'packages/policy/src/index.ts'),
      '@gerald/memory': resolve(__dirname, 'packages/memory/src/index.ts'),
      '@gerald/tasks': resolve(__dirname, 'packages/tasks/src/index.ts'),
      '@gerald/runtime': resolve(__dirname, 'packages/runtime/src/index.ts'),
      '@gerald/google': resolve(__dirname, 'packages/connectors-google/src/index.ts'),
      '@gerald/email': resolve(__dirname, 'packages/connectors-email/src/index.ts'),
    },
  },
});
