import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const ADMIN_KEY = 'el_admin_credentials_v1';
const ITERATIONS = 210_000;
const HASH_LENGTH = 32;

type AdminRecord = { username: string; salt: string; hash: string };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const hash = await pbkdf2Async(sha256, password, salt, { c: ITERATIONS, dkLen: HASH_LENGTH });
  return bytesToHex(hash);
}

function displayName(value: string) {
  const clean = value.trim().replace(/[_.-]+/g, ' ');
  return clean ? clean.replace(/\b\w/g, char => char.toUpperCase()) : 'Admin';
}

function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const router = useRouter();
  const db = useSQLiteContext();

  const [checking, setChecking] = useState(true);
  const [adminExists, setAdminExists] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedUsername, setSavedUsername] = useState('Admin');
  const [showNetWorth, setShowNetWorth] = useState(true);
  const [netWorth, setNetWorth] = useState(0);
  const [netWorthInput, setNetWorthInput] = useState('0');
  const [editNetWorthVisible, setEditNetWorthVisible] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [splashDone, setSplashDone] = useState(false);

  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.78)).current;
  const screenOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.spring(logoScale, { toValue: 1, friction: 5, tension: 55, useNativeDriver: true }),
    ]).start(() => {
      setTimeout(() => {
        Animated.timing(screenOpacity, { toValue: 1, duration: 550, useNativeDriver: true }).start();
        setSplashDone(true);
      }, 650);
    });
  }, [logoOpacity, logoScale, screenOpacity]);

  useEffect(() => {
    let mounted = true;
    SecureStore.getItemAsync(ADMIN_KEY)
      .then(value => {
        if (!mounted) return;
        setAdminExists(Boolean(value));
        if (value) {
          try {
            const record = JSON.parse(value) as AdminRecord;
            setSavedUsername(record.username || 'Admin');
          } catch {}
        }
      })
      .catch(() => Alert.alert('Storage error', 'Unable to access secure storage. Please restart the app and try again.'))
      .finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let mounted = true;
    (async () => {
      try {
        const savedWorth = await db.getFirstAsync<{ value: string }>(
          'SELECT value FROM settings WHERE key = ?', 'manual_net_worth'
        );
        if (!savedWorth) {
          await db.runAsync('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', 'manual_net_worth', '0');
        }
        const savedTheme = await db.getFirstAsync<{ value: string }>(
          'SELECT value FROM settings WHERE key = ?', 'app_theme'
        );
        const savedValue = Number(savedWorth?.value ?? 0);
        if (mounted) {
          setNetWorth(Number.isFinite(savedValue) ? savedValue : 0);
          setNetWorthInput(String(Number.isFinite(savedValue) ? savedValue : 0));
          setTheme(savedTheme?.value === 'light' ? 'light' : 'dark');
        }

        // Ask for notification permission after the user opens the dashboard.
        const currentPermission = await Notifications.getPermissionsAsync();
        let granted = currentPermission.granted;
        if (!granted) {
          const requested = await Notifications.requestPermissionsAsync();
          granted = requested.granted;
        }
        if (granted) {
          const dueLoans = await db.getAllAsync<{
            id: number; borrower_name: string; principal: number; total_due: number;
            due_date: string; status: string; paid: number;
          }>(`SELECT l.id, b.full_name AS borrower_name, l.principal, l.total_due,
              l.due_date, l.status, COALESCE(SUM(p.amount), 0) AS paid
            FROM loans l JOIN borrowers b ON b.id = l.borrower_id
            LEFT JOIN payments p ON p.loan_id = l.id
            WHERE l.due_date IS NOT NULL AND l.status != 'cancelled'
            GROUP BY l.id`);
          // Rebuild only this app's reminders each time the dashboard is opened.
          const existing = await Notifications.getAllScheduledNotificationsAsync();
          for (const item of existing) {
            if (item.content.data?.emergencyLoanReminder === true) {
              await Notifications.cancelScheduledNotificationAsync(item.identifier);
            }
          }
          const now = new Date();
          for (const loan of dueLoans) {
            if (Number(loan.paid || 0) >= Number(loan.total_due || 0) - 0.001) continue;
            const due = new Date(`${loan.due_date}T09:00:00`);
            if (Number.isNaN(due.getTime())) continue;
            for (const daysBefore of [3, 1, 0]) {
              const fireAt = new Date(due);
              fireAt.setDate(fireAt.getDate() - daysBefore);
              if (fireAt <= now) continue;
              const dueLabel = daysBefore === 0 ? 'is due today' : `is due in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
              await Notifications.scheduleNotificationAsync({
                content: {
                  title: `Loan due reminder: ${loan.borrower_name}`,
                  body: `Loan #${loan.id} ${dueLabel}. Principal: ₱${Number(loan.principal).toLocaleString('en-PH')}. Total due: ₱${Number(loan.total_due).toLocaleString('en-PH')}. Due date: ${loan.due_date}.`,
                  data: { emergencyLoanReminder: true, loanId: loan.id },
                },
                trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
              });
            }
          }
        }
      } catch (error) {
        console.warn('Could not load dashboard settings or schedule due reminders:', error);
      }
    })();
    return () => { mounted = false; };
  }, [authenticated, db]);

  const saveNetWorth = async () => {
    const parsed = Number(netWorthInput.replace(/,/g, '').trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      Alert.alert('Invalid amount', 'Enter a valid amount of 0 or more.');
      return;
    }
    try {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'manual_net_worth', String(parsed));
      setNetWorth(parsed);
      setEditNetWorthVisible(false);
    } catch {
      Alert.alert('Save failed', 'Could not save your net worth. Please check your database setup.');
    }
  };

  const toggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'app_theme', next);
    } catch (error) {
      console.warn('Could not save theme preference:', error);
    }
  };

  const handleCreateAdmin = async () => {
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,30}$/.test(cleanUsername)) {
      Alert.alert('Invalid username', 'Use 3–30 characters: letters, numbers, dots, underscores, or hyphens.');
      return;
    }
    if (password.length < 10) {
      Alert.alert('Weak password', 'Use at least 10 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Please enter the same password twice.');
      return;
    }
    setBusy(true);
    try {
      const existing = await SecureStore.getItemAsync(ADMIN_KEY);
      if (existing) {
        setAdminExists(true);
        Alert.alert('Admin already exists', 'Please log in.');
        return;
      }
      const salt = Crypto.getRandomBytes(16);
      const record: AdminRecord = {
        username: cleanUsername,
        salt: bytesToHex(salt),
        hash: await hashPassword(password, salt),
      };
      await SecureStore.setItemAsync(ADMIN_KEY, JSON.stringify(record));
      setAdminExists(true);
      setSavedUsername(cleanUsername);
      setAuthenticated(true);
      setPassword('');
      setConfirmPassword('');
      Alert.alert('Admin created', 'Your administrator account is ready.');
    } catch {
      Alert.alert('Setup failed', 'Could not save your admin account securely.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setBusy(true);
    try {
      const saved = await SecureStore.getItemAsync(ADMIN_KEY);
      if (!saved) {
        setAdminExists(false);
        Alert.alert('Admin not found', 'Please set up the administrator account.');
        return;
      }
      const record = JSON.parse(saved) as AdminRecord;
      const cleanUsername = username.trim().toLowerCase();
      if (cleanUsername !== record.username) {
        Alert.alert('Login failed', 'Incorrect username or password.');
        return;
      }
      const attemptedHash = await hashPassword(password, hexToBytes(record.salt));
      if (attemptedHash !== record.hash) {
        Alert.alert('Login failed', 'Incorrect username or password.');
        return;
      }
      setSavedUsername(record.username);
      setAuthenticated(true);
      setPassword('');
    } catch {
      Alert.alert('Login error', 'Could not verify your credentials.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log out?', 'Your saved loan records will remain on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => {
        setAuthenticated(false);
        setPassword('');
        setUsername('');
      }},
    ]);
  };

  const money = (amount: number) => '₱' + Number(amount || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  if (!splashDone) {
    return (
      <SafeAreaView style={styles.safe}>
        <LinearGradient colors={['#08090B', '#242629', '#111214']} style={styles.splash}>
          <Animated.View style={{ opacity: logoOpacity, transform: [{ scale: logoScale }] }}>
            <View style={styles.splashLogoBox}>
              <View style={styles.monogramRow}>
                <Text style={styles.logoE}>E</Text>
                <Text style={styles.logoL}>L</Text>
              </View>
            </View>
          </Animated.View>
          <Animated.Text style={[styles.splashTitle, { opacity: logoOpacity }]}>EMERGENCY LOAN</Animated.Text>
          <Animated.Text style={[styles.splashCaption, { opacity: logoOpacity }]}>Your finances, clearly managed.</Animated.Text>
        </LinearGradient>
      </SafeAreaView>
    );
  }

  if (checking) {
    return (
      <SafeAreaView style={styles.safe}>
        <LinearGradient colors={['#101113', '#292B2F', '#151618']} style={styles.center}>
          <ActivityIndicator size="large" color="#D1D5DB" />
          <Text style={styles.mutedText}>Preparing your account...</Text>
        </LinearGradient>
      </SafeAreaView>
    );
  }

  if (authenticated) {
    return (
      <SafeAreaView style={[styles.safe, theme === 'light' && { backgroundColor: '#F3F4F6' }]}>
        <LinearGradient colors={theme === 'light' ? ['#F8FAFC', '#E5E7EB', '#F3F4F6'] : ['#111214', '#27292D', '#17181A']} style={styles.flex}>
          <ScrollView contentContainerStyle={styles.dashboardPage}>
            <Animated.View style={{ opacity: screenOpacity }}>
              <View style={styles.dashboardHeader}>
                <Brand />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Pressable accessibilityLabel={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onPress={toggleTheme} style={({ pressed }) => [styles.logoutButton, theme === 'light' && { backgroundColor: '#FFFFFF', borderColor: '#D1D5DB' }, pressed && styles.pressed]}>
                    <Text style={[styles.logoutText, theme === 'light' && { color: '#111827' }]}>{theme === 'dark' ? '☀️ Light' : '🌙 Dark'}</Text>
                  </Pressable>
                  <Pressable onPress={handleLogout} style={({ pressed }) => [styles.logoutButton, theme === 'light' && { backgroundColor: '#FFFFFF', borderColor: '#D1D5DB' }, pressed && styles.pressed]}>
                    <Text style={[styles.logoutText, theme === 'light' && { color: '#111827' }]}>Log out</Text>
                  </Pressable>
                </View>
              </View>

              <Text style={[styles.greeting, theme === 'light' && { color: '#111827' }]}>{greeting()}, {displayName(savedUsername)}.</Text>
              <Text style={[styles.dashboardSubheading, theme === 'light' && { color: '#4B5563' }]}>Here is your financial overview.</Text>

              <LinearGradient colors={theme === 'light' ? ['#DBEAFE', '#BFDBFE', '#EFF6FF'] : ['#4A4D52', '#303236', '#202124']} style={[styles.netWorthCard, theme === 'light' && { borderColor: '#93C5FD' }]}>
                <View style={styles.netWorthTop}>
                  <Text style={[styles.netWorthLabel, theme === 'light' && { color: '#1F2937' }]}>NET WORTH</Text>
                  <View style={{ flexDirection: 'row', gap: 7 }}>
                  <Pressable onPress={() => { setNetWorthInput(String(netWorth)); setEditNetWorthVisible(true); }} style={[styles.visibilityButton, theme === 'light' && { backgroundColor: '#2563EB' }]}><Text style={styles.visibilityText}>Edit</Text></Pressable>
                  <Pressable onPress={() => setShowNetWorth(v => !v)} style={styles.visibilityButton}>
                    <Text style={styles.visibilityText}>{showNetWorth ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                  </View>
                </View>
                <Text style={[styles.netWorthAmount, theme === 'light' && { color: '#111827' }]}>{showNetWorth ? money(netWorth) : '₱ ••••••'}</Text>
                <Text style={[styles.netWorthCaption, theme === 'light' && { color: '#374151' }]}>All cash, savings, and other money you currently have</Text>
              </LinearGradient>

              <View style={[styles.dashboardCard, theme === 'light' && { backgroundColor: '#FFFFFF', borderColor: '#D1D5DB' }]}>
                <Text style={[styles.sectionTitle, theme === 'light' && { color: '#111827' }]}>Manage your records</Text>
                <Text style={[styles.cardBody, theme === 'light' && { color: '#4B5563' }]}>Manage borrowers, review loans, record payments, and check outstanding balances.</Text>
                <Pressable
                  onPress={() => router.push('/loans')}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryButtonText}>Open Loan Management</Text>
                </Pressable>
              </View>
              <Text style={[styles.footer, theme === 'light' && { color: '#6B7280' }]}>EMERGENCY LOAN · VERSION 1.0.0</Text>
            </Animated.View>
          </ScrollView>
          <Modal visible={editNetWorthVisible} transparent animationType="fade" onRequestClose={() => setEditNetWorthVisible(false)}>
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 24 }}>
              <View style={{ backgroundColor: theme === 'light' ? '#FFFFFF' : '#292B2F', borderRadius: 20, borderWidth: 1, borderColor: theme === 'light' ? '#D1D5DB' : '#484B50', padding: 20 }}>
                <Text style={{ color: theme === 'light' ? '#111827' : '#F9FAFB', fontSize: 20, fontWeight: '900' }}>Edit net worth</Text>
                <Text style={{ color: theme === 'light' ? '#4B5563' : '#BFC2C8', marginTop: 8, lineHeight: 20 }}>Enter all the money you currently have, including cash and savings. This is your personal total, separate from loan records.</Text>
                <TextInput value={netWorthInput} onChangeText={setNetWorthInput} keyboardType="decimal-pad" placeholder="e.g. 15000" placeholderTextColor="#92959B" style={[styles.input, { marginTop: 16 }]} />
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                  <Pressable onPress={() => setEditNetWorthVisible(false)} style={[styles.logoutButton, { flex: 1, alignItems: 'center' }]}><Text style={styles.logoutText}>Cancel</Text></Pressable>
                  <Pressable onPress={saveNetWorth} style={[styles.primaryButton, { flex: 1, marginTop: 0 }]}><Text style={styles.primaryButtonText}>Save amount</Text></Pressable>
                </View>
              </View>
            </View>
          </Modal>
        </LinearGradient>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={['#111214', '#292B2F', '#151618']} style={styles.flex}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View style={{ flex: 1, opacity: screenOpacity }}>
            <ScrollView contentContainerStyle={styles.loginPage} keyboardShouldPersistTaps="handled">
              <View style={styles.loginBrandArea}>
                <Brand />
                <Text style={styles.loginHeading}>{adminExists ? 'Welcome back' : 'Create your admin account'}</Text>
                <Text style={styles.loginDescription}>
                  {adminExists ? 'Sign in to continue to your dashboard.' : 'Set up the administrator account for this device.'}
                </Text>
              </View>

              <View style={styles.formCard}>
                <Text style={styles.label}>USERNAME</Text>
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Enter username"
                  placeholderTextColor="#92959B"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={30}
                  editable={!busy}
                  style={styles.input}
                  returnKeyType="next"
                />
                <Text style={styles.label}>PASSWORD</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Enter password"
                    placeholderTextColor="#92959B"
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                    style={[styles.input, styles.passwordInput]}
                    returnKeyType={adminExists ? 'done' : 'next'}
                  />
                  <Pressable onPress={() => setShowPassword(v => !v)} style={styles.showPasswordButton}>
                    <Text style={styles.showPasswordText}>{showPassword ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                </View>

                {!adminExists && (
                  <>
                    <Text style={styles.label}>CONFIRM PASSWORD</Text>
                    <TextInput
                      value={confirmPassword}
                      onChangeText={setConfirmPassword}
                      placeholder="Re-enter password"
                      placeholderTextColor="#92959B"
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!busy}
                      style={styles.input}
                      returnKeyType="done"
                    />
                    <Text style={styles.hint}>Use at least 10 characters and keep your password safe.</Text>
                  </>
                )}

                <Pressable
                  disabled={busy}
                  onPress={adminExists ? handleLogin : handleCreateAdmin}
                  style={({ pressed }) => [styles.primaryButton, busy && styles.disabled, pressed && styles.pressed]}
                >
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : (
                    <Text style={styles.primaryButtonText}>{adminExists ? 'Log in' : 'Create admin account'}</Text>
                  )}
                </Pressable>
              </View>
              <Text style={styles.securityText}>Your account is protected on this device.</Text>
              <Text style={styles.footer}>EMERGENCY LOAN · VERSION 1.0.0</Text>
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </LinearGradient>
    </SafeAreaView>
  );
}

function Brand() {
  return (
    <View style={styles.brandRow}>
      <View style={styles.brandLogoBox}>
        <View style={styles.monogramRow}>
          <Text style={styles.brandLogoE}>E</Text>
          <Text style={styles.brandLogoL}>L</Text>
        </View>
      </View>
      <View>
        <Text style={styles.brandTitle}>EMERGENCY LOAN</Text>
        <Text style={styles.brandSubtitle}>FINANCIAL RECORDS</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#111214' },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  splashLogoBox: {
    width: 116, height: 116, borderRadius: 32, backgroundColor: '#55585E',
    borderWidth: 1, borderColor: '#858990', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#D1D5DB', shadowOpacity: 0.24, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 12,
  },
  monogramRow: { flexDirection: 'row', alignItems: 'center' },
  logoE: { fontSize: 66, fontWeight: '900', fontStyle: 'italic', color: '#F9FAFB', letterSpacing: -9 },
  logoL: { fontSize: 66, fontWeight: '900', fontStyle: 'italic', color: '#BFC3C9', marginLeft: 4 },
  splashTitle: { color: '#F3F4F6', fontSize: 16, fontWeight: '900', letterSpacing: 2.3, marginTop: 28 },
  splashCaption: { color: '#A7A9AE', fontSize: 12, marginTop: 9 },
  mutedText: { color: '#B8BBC1', marginTop: 12 },
  dashboardPage: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 24 },
  loginPage: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 30, paddingBottom: 24, justifyContent: 'center' },
  dashboardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 34 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  brandLogoBox: { width: 52, height: 52, borderRadius: 16, backgroundColor: '#4A4D52', borderWidth: 1, borderColor: '#777B83', alignItems: 'center', justifyContent: 'center' },
  brandLogoE: { fontSize: 32, fontWeight: '900', fontStyle: 'italic', color: '#FFFFFF', letterSpacing: -5 },
  brandLogoL: { fontSize: 32, fontWeight: '900', fontStyle: 'italic', color: '#C4C7CC', marginLeft: 2 },
  brandTitle: { color: '#F3F4F6', fontSize: 13, fontWeight: '900', letterSpacing: 0.6 },
  brandSubtitle: { color: '#A3A6AC', fontSize: 9, fontWeight: '700', letterSpacing: 1.2, marginTop: 5 },
  logoutButton: { borderWidth: 1, borderColor: '#696C72', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 10, backgroundColor: '#303236' },
  logoutText: { color: '#F3F4F6', fontWeight: '800', fontSize: 12 },
  greeting: { color: '#F9FAFB', fontSize: 27, fontWeight: '900', letterSpacing: -0.6 },
  dashboardSubheading: { color: '#B4B7BD', fontSize: 13, marginTop: 8, marginBottom: 23 },
  netWorthCard: { borderRadius: 24, padding: 23, borderWidth: 1, borderColor: '#62656B', marginBottom: 17 },
  netWorthTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  netWorthLabel: { color: '#D1D5DB', fontSize: 11, fontWeight: '900', letterSpacing: 1.8 },
  visibilityButton: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: '#55585E' },
  visibilityText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  netWorthAmount: { color: '#FFFFFF', fontSize: 31, fontWeight: '900', marginTop: 18, letterSpacing: -0.8 },
  netWorthCaption: { color: '#C0C3C8', fontSize: 11, marginTop: 8 },
  dashboardCard: { backgroundColor: '#292B2F', borderWidth: 1, borderColor: '#484B50', borderRadius: 22, padding: 20, marginTop: 2 },
  sectionTitle: { color: '#F3F4F6', fontSize: 18, fontWeight: '900' },
  cardBody: { color: '#BFC2C8', fontSize: 13, lineHeight: 20, marginTop: 9, marginBottom: 15 },
  loginBrandArea: { alignItems: 'center', marginBottom: 28 },
  loginHeading: { color: '#F9FAFB', fontSize: 25, fontWeight: '900', textAlign: 'center', marginTop: 26 },
  loginDescription: { color: '#B4B7BD', fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8, maxWidth: 300 },
  formCard: { backgroundColor: '#282A2E', borderWidth: 1, borderColor: '#484B50', borderRadius: 23, padding: 20 },
  label: { color: '#E5E7EB', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 10, marginBottom: 7 },
  input: { backgroundColor: '#1A1B1E', borderWidth: 1, borderColor: '#50535A', borderRadius: 12, minHeight: 50, paddingHorizontal: 14, paddingVertical: 12, color: '#F9FAFB', fontSize: 14 },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  passwordInput: { flex: 1 },
  showPasswordButton: { backgroundColor: '#45484D', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  showPasswordText: { color: '#F3F4F6', fontWeight: '800', fontSize: 11 },
  hint: { color: '#AEB1B7', fontSize: 11, lineHeight: 16, marginTop: 8 },
  primaryButton: { backgroundColor: '#62666D', borderWidth: 1, borderColor: '#858991', borderRadius: 13, minHeight: 51, paddingHorizontal: 15, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', textAlign: 'center' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.6 },
  securityText: { color: '#AEB1B7', fontSize: 11, textAlign: 'center', marginTop: 20 },
  footer: { color: '#858990', fontSize: 9, textAlign: 'center', letterSpacing: 1.4, marginTop: 28 },
});
