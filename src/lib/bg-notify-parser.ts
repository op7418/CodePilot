/**
 * Parse notification API response for background polling.
 * Pure function — no Electron dependencies, used by both electron/main.ts
 * and unit tests.
 */
export function parseBgNotifications(json: string): Array<{ title: string; body: string; priority: string }> {
  try {
    const parsed = JSON.parse(json);
    const notifications: Array<{ title: string; body: string; priority: string }> = parsed.notifications || [];
    // Filter out notifications without title
    return notifications.filter(n => n.title);
  } catch {
    return [];
  }
}
