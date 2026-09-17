import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Относительная база: собранный dist работает и с file://, и из подпапки —
  // приложение запускается без установки и без сервера.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5174,
    open: false,
  },
  test: {
    // Ядро симуляции не знает про DOM — тесты идут в чистом Node.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Тесты сохранения энергии прогоняют тысячи шагов с честным пересчётом
    // сил: 5 секунд по умолчанию для них мало.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Нагрузочные тесты исключены из обычного прогона: они долгие и зависят
    // от машины. Запускаются отдельно: npm run bench.
    exclude: ['**/node_modules/**', 'src/bench/**'],
  },
});
