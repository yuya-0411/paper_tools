/*
 * Optional cloud synchronization configuration.
 *
 * The application remains fully usable in local-only mode while `enabled` is
 * false.  To enable synchronization, follow docs/cloud-sync-setup.md and enter
 * only a Supabase publishable key (or the legacy `anon` key).
 *
 * Never place a `service_role`, `sb_secret_...`, database password, or any
 * other server-side secret in this file.  Files served by GitHub Pages are
 * public by design.
 */
window.PAPER_TOOLS_CLOUD = Object.freeze({
  enabled: false,
  supabaseUrl: "",
  publishableKey: "",
});
