/**
 * The testbed app: a home screen and four screens, each with a seeded crash
 * (README.md). A screen opens from its button, or at launch: the trigger
 * script launches the app with a screen's name.
 *
 * @format
 */

import { useEffect, useState } from 'react';
import {
  Button,
  Linking,
  Platform,
  ScrollView,
  Settings,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  getCrashlytics,
  log,
  recordError,
  setAttribute,
  setUserId,
} from '@react-native-firebase/crashlytics';
import { backend } from './src/backend';
import { loadHeadline } from './src/inbox';
import { parseProfile, type Profile } from './src/profile';
import { TagList } from './src/TagList';
import { groupByDay, type Update } from './src/updates';

type Screen =
  | { name: 'home' }
  | { name: 'profile'; profile: Profile }
  | { name: 'tags' }
  | { name: 'inbox' }
  | { name: 'updates'; groups: [string, Update[]][] };

const SCREENS = ['profile', 'tags', 'inbox', 'updates'] as const;

/** Synthetic telemetry: a user id, the open screen and a log line reach Crashlytics with each report. */
function track(screen: string) {
  const crashlytics = getCrashlytics();
  setAttribute(crashlytics, 'screen', screen);
  log(crashlytics, `open ${screen}`);
}

/** The screen to show for a name. Profile and updates are prepared here, before they show. */
function prepare(name: string): Screen {
  track(name);
  switch (name) {
    case 'profile':
      return { name: 'profile', profile: parseProfile(backend.profileJson()) };
    case 'tags':
      return { name: 'tags' };
    case 'inbox':
      return { name: 'inbox' };
    case 'updates':
      return { name: 'updates', groups: groupByDay(backend.updates()) };
    default:
      return { name: 'home' };
  }
}

/**
 * The screen the app was launched with: a link, `testbedrn://<screen>`, on
 * Android, and a launch argument, `-screen <screen>`, on iOS, where a link
 * opened from the command line waits for a tap on a confirmation.
 */
async function launchScreen(): Promise<string | undefined> {
  if (Platform.OS === 'ios') return Settings.get('screen') ?? undefined;
  const url = await Linking.getInitialURL();
  return url?.replace(/^testbedrn:\/\//, '');
}

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  useEffect(() => {
    setUserId(getCrashlytics(), 'test-user-0001');
    launchScreen().then(name => {
      // A timer opens it, as a button's handler would: an error there is a
      // crash, where in this promise it would be a rejection.
      if (name) setTimeout(() => setScreen(prepare(name)), 0);
    });
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        {screen.name !== 'home' && (
          <Button title="Back" onPress={() => setScreen({ name: 'home' })} />
        )}
        <ScrollView contentContainerStyle={styles.content}>
          {body(screen, setScreen)}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function body(screen: Screen, setScreen: (s: Screen) => void) {
  switch (screen.name) {
    case 'home':
      return SCREENS.map(name => (
        <Button
          key={name}
          title={`Open ${name}`}
          onPress={() => setScreen(prepare(name))}
        />
      ));
    case 'profile':
      return <Text style={styles.title}>{screen.profile.name}</Text>;
    case 'tags':
      return <TagList page={backend.tagPage()} />;
    case 'inbox':
      return <InboxScreen />;
    case 'updates':
      return screen.groups.map(([day, updates]) => (
        <View key={day}>
          <Text style={styles.title}>{day}</Text>
          {updates.map(u => (
            <Text key={u.title}>{u.title}</Text>
          ))}
        </View>
      ));
  }
}

function InboxScreen() {
  const [headline, setHeadline] = useState('Loading…');

  useEffect(() => {
    loadHeadline(backend)
      .then(setHeadline)
      .catch((e: Error) => {
        recordError(getCrashlytics(), e);
        setHeadline('Inbox unavailable');
      });
  }, []);

  return <Text style={styles.title}>{headline}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 8 },
  title: { fontSize: 18, fontWeight: '600' },
});

export default App;
