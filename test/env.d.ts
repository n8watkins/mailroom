declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      GLOBAL_DAY_CAP: string;
      PRIORITY_RESERVE: string;
      TEST_MIGRATIONS: D1Migration[];
      TEST_DEPLOYMENTS: Array<{ config: string; apps: string | null; allowedSenders: string[] | null; services: string[]; globalDayCap: number; globalMonthCap: number }>;
    }
  }
}

export {};
