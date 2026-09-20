export default defineNuxtConfig({
  modules: ['eve/nuxt'],
  devtools: { enabled: false },
  ssr: false,
  // Keep Eve's private #shared imports out of Nuxt's #shared alias.
  nitro: { externals: { external: ['eve'] }, vercel: { functions: { runtime: 'nodejs24.x', maxDuration: 90 } } },
  routeRules: { '/api/**': { headers: { 'cache-control': 'no-store' } } },
  app: { head: { title: 'Project Steward', meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }] } },
});
