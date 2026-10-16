import { loadHeadline } from '../src/inbox';

test('the headline is the newest item', async () => {
  const source = {
    inbox: async () => ({ items: [{ title: 'Welcome' }, { title: 'Older' }] }),
  };
  await expect(loadHeadline(source)).resolves.toBe('Welcome');
});
