import { defineConfig } from 'vitest/config'
import path from 'path'

async function loadReporters() {
  const reporters: unknown[] = ['default']
  const importOptional = new Function('name', 'return import(name)') as (name: string) => Promise<any>

  try {
    const { VitestReporter } = await importOptional('tdd-guard-vitest')
    reporters.push(new VitestReporter(path.resolve(__dirname, '..')))
  } catch (error) {
    if (process.env.TDD_GUARD_REPORTER === 'required') {
      throw error
    }
  }

  return reporters
}

export default defineConfig(async () => ({
  test: {
    reporters: await loadReporters(),
    testTimeout: 30000,
    retry: {
      count: 2,
      delay: 500,
      condition: /ENOENT|EPERM|ECONNREFUSED/,
    },
  },
}))
