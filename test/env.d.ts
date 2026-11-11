declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      GLOBAL_DAY_CAP: string;
      PRIORITY_RESERVE: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
