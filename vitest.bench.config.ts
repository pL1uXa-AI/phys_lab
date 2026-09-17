import { defineConfig } from 'vitest/config';

/**
 * Конфигурация нагрузочных тестов.
 *
 * Отдельно от основного прогона, потому что эти тесты долгие и зависят от
 * машины: их результат — числа, а не «прошло/не прошло». Запуск:
 * `npm run bench`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/bench/**/*.test.ts'],
    testTimeout: 120000,
    // Нагрузочные тесты нельзя гонять параллельно: они меряют время, и
    // конкуренция за процессор исказила бы числа.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
