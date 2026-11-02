interface Env {
  DB: D1Database;
  APPLE_PASS_AUTH_TOKEN?: string;
  ADMIN_API_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_ENVIRONMENT?: "sandbox" | "production";
}
