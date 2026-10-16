import { parseProfile } from '../src/profile';

test('parses a profile', () => {
  const json = JSON.stringify({
    id: 'u-1',
    name: 'Ada',
    avatar: { url: 'https://example.com/a.png' },
  });
  expect(parseProfile(json)).toEqual({
    id: 'u-1',
    name: 'Ada',
    avatarUrl: 'https://example.com/a.png',
  });
});
