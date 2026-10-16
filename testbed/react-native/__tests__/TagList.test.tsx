import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import { TagList } from '../src/TagList';

test('renders a row per tag', async () => {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <TagList page={{ total: 2, tags: [{ label: 'a' }, { label: 'b' }] }} />,
    );
  });
  const texts = renderer.root.findAllByType(Text).map(t => t.props.children);
  expect(texts).toEqual([[2, ' tags'], 'a', 'b']);
});
