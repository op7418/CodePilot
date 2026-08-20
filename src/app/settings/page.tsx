import { redirect } from "next/navigation";

/**
 * /settings root — server redirect, no section imports.
 *
 * Memory contract: this page must NOT import any settings section. The
 * Overview dashboard lives at /settings/overview so this file stays a
 * pure bounce (see `src/__tests__/unit/settings-routes-shape.test.ts`
 * and `settings-link-migration.test.ts`).
 *
 * A server `redirect()` from `next/navigation` avoids the client-side
 * empty tick (`return null` + `router.replace`) that flashed a blank
 * page before /settings/overview painted.
 *
 * Legacy `/settings#section` hashes are not sent to the server; current
 * in-app links use `/settings/<section>`.
 */
export default function SettingsRootRedirectPage() {
  redirect("/settings/overview");
}
