
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';

export default function HomeScreen() {
  const systemTheme = useColorScheme();
  const [themeChoice, setThemeChoice] = useState<'system' | 'light' | 'dark'>('system');
  const [started, setStarted] = useState(false);

  const isDark =
    themeChoice === 'dark' ||
    (themeChoice === 'system' && systemTheme === 'dark');

  const glow = useRef(new Animated.Value(0.35)).current;
  const scale = useRef(new Animated.Value(0.94)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(glow, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(glow, {
            toValue: 0.35,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 0.94,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, [glow, scale]);

  const colors = {
    background: isDark ? '#061329' : '#F3F7FF',
    surface: isDark ? '#102442' : '#FFFFFF',
    text: isDark ? '#F8FAFF' : '#102447',
    muted: isDark ? '#A7B9D5' : '#64748B',
    border: isDark ? '#263C5B' : '#DCE6F5',
    blue: '#2878FF',
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        <View style={styles.themeRow}>
          <View style={styles.offlineBadge}>
            <View style={styles.onlineDot} />
            <Text style={styles.offlineText}>OFFLINE MODE</Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change appearance"
            onPress={() => {
              setThemeChoice(current =>
                current === 'system'
                  ? 'dark'
                  : current === 'dark'
                    ? 'light'
                    : 'system'
              );
            }}
            style={[styles.themeButton, {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            }]}
          >
            <MaterialCommunityIcons
              name={isDark ? 'weather-night' : 'white-balance-sunny'}
              size={21}
              color={colors.text}
            />
          </Pressable>
        </View>

        <View style={styles.hero}>
          <Animated.View
            style={[
              styles.logoGlow,
              {
                opacity: glow,
                transform: [{ scale }],
              },
            ]}
          />

          <LinearGradient
            colors={isDark
              ? ['#143D85', '#071B3D', '#030C20']
              : ['#327EFF', '#1452C5', '#092B70']}
            style={styles.logo}
          >
            <View style={styles.monogram}>
              <Text style={styles.logoE}>E</Text>
              <Text style={styles.logoL}>L</Text>
            </View>
            <MaterialCommunityIcons
              name="database"
              size={27}
              color="#FFFFFF"
              style={styles.databaseIcon}
            />
          </LinearGradient>

          <Text style={[styles.title, { color: colors.text }]}>
            EMERGENCY <Text style={styles.blueText}>LOAN</Text>
          </Text>

          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Your loans. Your records. Your control.
          </Text>

          <View style={styles.featureRow}>
            <MaterialCommunityIcons
              name="shield-check"
              size={17}
              color="#3B82F6"
            />
            <Text style={[styles.featureText, { color: colors.muted }]}>
              Private and stored on your device
            </Text>
          </View>
        </View>

        <View style={[styles.bottomCard, {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            {started ? 'Foundation ready' : 'Welcome to EL'}
          </Text>
          <Text style={[styles.cardText, { color: colors.muted }]}>
            {started
              ? 'Next: secure admin setup and your local SQLite database.'
              : 'A simple, secure loan management app designed to work offline.'}
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={() => setStarted(true)}
            style={({ pressed }) => [
              styles.primaryButton,
              { opacity: pressed ? 0.82 : 1 },
            ]}
          >
            <LinearGradient
              colors={['#438CFF', '#1458E8']}
              style={styles.buttonGradient}
            >
              <Text style={styles.buttonText}>
                {started ? 'Ready for Step 2' : 'Get Started'}
              </Text>
              <MaterialCommunityIcons
                name="arrow-right"
                size={20}
                color="#FFFFFF"
              />
            </LinearGradient>
          </Pressable>
        </View>

        <Text style={[styles.footer, { color: colors.muted }]}>
          EMERGENCY LOAN  •  VERSION 1.0.0
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: 25,
    paddingTop: 12,
    paddingBottom: 16,
    justifyContent: 'space-between',
  },
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  offlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#12315A',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 30,
  },
  onlineDot: {
    width: 7,
    height: 7,
    borderRadius: 5,
    backgroundColor: '#43D69A',
  },
  offlineText: {
    color: '#C9DEFF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  themeButton: {
    width: 43,
    height: 43,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 22,
  },
  logoGlow: {
    position: 'absolute',
    top: '12%',
    width: 190,
    height: 190,
    borderRadius: 55,
    backgroundColor: '#1677FF',
    shadowColor: '#1680FF',
    shadowOpacity: 1,
    shadowRadius: 42,
    elevation: 18,
  },
  logo: {
    width: 158,
    height: 158,
    borderRadius: 43,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#68B5FF',
    elevation: 14,
  },
  monogram: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoE: {
    fontSize: 76,
    fontWeight: '900',
    fontStyle: 'italic',
    color: '#FFFFFF',
    letterSpacing: -9,
  },
  logoL: {
    fontSize: 76,
    fontWeight: '900',
    fontStyle: 'italic',
    color: '#58C5FF',
    marginLeft: 3,
  },
  databaseIcon: {
    position: 'absolute',
    bottom: 13,
    right: 15,
  },
  title: {
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: 1.3,
    marginTop: 27,
    textAlign: 'center',
  },
  blueText: { color: '#3987FF' },
  subtitle: {
    fontSize: 13,
    marginTop: 9,
    textAlign: 'center',
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 22,
  },
  featureText: { fontSize: 12 },
  bottomCard: {
    borderWidth: 1,
    borderRadius: 25,
    padding: 22,
    gap: 10,
  },
  cardTitle: { fontSize: 20, fontWeight: '800' },
  cardText: { fontSize: 13, lineHeight: 20 },
  primaryButton: {
    borderRadius: 15,
    overflow: 'hidden',
    marginTop: 7,
  },
  buttonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 16,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  footer: {
    textAlign: 'center',
    fontSize: 9,
    letterSpacing: 1.5,
    marginTop: 12,
  },
});
