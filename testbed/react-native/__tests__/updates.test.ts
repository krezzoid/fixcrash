import { dayKey, groupByDay } from '../src/updates';

test('an update belongs to its UTC day', () => {
  expect(dayKey('2026/10/16 12:00')).toBe('2026-10-16');
});

test('a malformed time has no day', () => {
  expect(dayKey('yesterday')).toBeUndefined();
});

test('groups updates by day, newest first', () => {
  const groups = groupByDay([
    { title: 'a', updatedAt: '2026/10/14 12:00' },
    { title: 'b', updatedAt: '2026/10/16 12:00' },
  ]);
  expect(groups.map(([day]) => day)).toEqual(['2026-10-16', '2026-10-14']);
});
