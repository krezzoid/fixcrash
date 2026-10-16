/* eslint-env jest */
// React Native Firebase's native modules don't exist under Jest: tests get stubs and report nothing.
jest.mock('@react-native-firebase/crashlytics', () => ({
  getCrashlytics: jest.fn(() => ({})),
  log: jest.fn(),
  recordError: jest.fn(),
  setAttribute: jest.fn(() => Promise.resolve(null)),
  setUserId: jest.fn(() => Promise.resolve(null)),
}));

// Neither is React Native's iOS settings store, which the app reads its launch screen from.
jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn(),
    watchKeys: jest.fn(),
    clearWatch: jest.fn(),
  },
}));
