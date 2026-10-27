module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      '(jest-)?react-native|' +
      '@react-native(-community)?|' +
      '@react-native-async-storage/async-storage|' +
      '@supabase/supabase-js|' +
      '@supabase/.*|' +
      'react-native-url-polyfill|' +
      '@notifee/react-native|' +
      'react-native-safe-area-context|' +
      'react-native-sound|' +
      'react-native-vector-icons' +
    ')/)',
  ],
  setupFiles: ['./jest.setup.js'],
  moduleNameMapper: {
    '@env': '<rootDir>/__mocks__/@env.js',
  },
};
