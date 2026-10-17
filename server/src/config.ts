// All configuration comes from environment variables, with defaults that work
// for local development. Docker Compose overrides these.
export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/newtonite',
  port: Number(process.env.PORT ?? 3000),
  // How many work items the seed script creates. 5,000 is enough to show that
  // filtering and pagination happen on the server, not in the browser.
  seedItemCount: Number(process.env.SEED_ITEM_COUNT ?? 5000),
  sessionTtlHours: 12,
  // Cookies marked Secure are only sent over HTTPS. Off for local http://localhost.
  secureCookies: process.env.SECURE_COOKIES === 'true',
};
