import { StyleSheet, Text, View } from 'react-native';

export interface Tag {
  label: string;
}

export interface TagPage {
  /** How many tags the user has, as the backend counts them. */
  total: number;
  tags: Tag[];
}

export function TagList({ page }: { page: TagPage }) {
  return (
    <View>
      <Text style={styles.header}>{page.total} tags</Text>
      {Array.from({ length: page.total }, (_, i) => (
        <Text key={i} style={styles.row}>
          {page.tags[i].label}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  row: { fontSize: 16, paddingVertical: 4 },
});
