
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { initializeDatabase } from '../lib/database';

export default function RootLayout() {
  return (
    <SQLiteProvider
      databaseName="emergencyloan.db"
      onInit={initializeDatabase}
    >
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
    </SQLiteProvider>
  );
}
