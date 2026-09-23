import { request, type FullConfig } from '@playwright/test';

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== 'string') {
    throw new Error('Playwright project is missing its isolated baseURL');
  }

  const api = await request.newContext({ baseURL });
  try {
    const setupResponse = await api.put('/api/setup', {
      data: { card: 'completed', status: 'completed' },
    });
    if (!setupResponse.ok()) {
      throw new Error(`Failed to seed isolated E2E setup state: ${setupResponse.status()}`);
    }

    const announcementResponse = await api.put('/api/settings/app', {
      data: {
        settings: { 'codepilot:announcement:v0.48-agent-engine': 'true' },
      },
    });
    if (!announcementResponse.ok()) {
      throw new Error(`Failed to seed isolated E2E announcement state: ${announcementResponse.status()}`);
    }
  } finally {
    await api.dispose();
  }
}
