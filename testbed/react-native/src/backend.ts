// A fake backend with synthetic data. Each response has the shape that
// crashes one scenario: the profile has no avatar, the tag page counts tags it
// doesn't send, the inbox is empty, and update times use slashes.

import type { TagPage } from './TagList';
import type { Inbox } from './inbox';
import type { Update } from './updates';

const delay = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export const backend = {
  profileJson(): string {
    return JSON.stringify({ id: 'u-0001', name: 'Test User' });
  },

  tagPage(): TagPage {
    return {
      total: 5,
      tags: [{ label: 'kotlin' }, { label: 'swift' }, { label: 'react' }],
    };
  },

  async inbox(): Promise<Inbox> {
    await delay(200);
    return { items: [] };
  },

  updates(): Update[] {
    return [
      { title: 'Release notes', updatedAt: '2026/10/16 10:00' },
      { title: 'Roadmap', updatedAt: '2026/10/14 09:30' },
    ];
  },
};

export type Backend = typeof backend;
