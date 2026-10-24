import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Vibration } from 'react-native';
import { getApp } from '@react-native-firebase/app';
import { getMessaging, requestPermission, getToken, onMessage, AuthorizationStatus } from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import * as Speech from 'expo-speech';
import { ensureChannels, showAlarmNotification } from './firebaseMessaging';
import Dashboard from './Dashboard';


const BACKEND_URL = 'http://192.168.20.128:3000'; // <-- your computer's local IP + port 3000

const WRITTEN_LANGS = ['English', 'Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali'];
const VOICE_LANGS = WRITTEN_LANGS;

export default function App() {
  const [screen, setScreen] = useState('setup');
  const [writtenLang, setWrittenLang] = useState('English');
  const [voiceLang, setVoiceLang] = useState('English');
  const [alarmItem, setAlarmItem] = useState(null);
  const [log, setLog] = useState([]);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => { ensureChannels(); }, []);

  // On launch: open straight to the alarm if a notification started the app,
  // and skip the setup screen if the backend is already monitoring this phone.
  useEffect(() => {
    (async () => {
      try {
        const initial = await notifee.getInitialNotification();
        if (initial?.notification?.data) {
          const d = initial.notification.data;
          ackSeen(d.emailId);
          if (initial.notification.id) await notifee.cancelNotification(initial.notification.id);
          openFromNotification(d);
        }
      } catch (e) {}
      try {
        const res = await fetch(`${BACKEND_URL}/status`);
        const s = await res.json();
        if (s.device) {
          setWrittenLang(s.device.writtenLang || 'English');
          setVoiceLang(s.device.voiceLang || 'English');
          setScreen(cur => (cur === 'setup' ? 'home' : cur));
        }
      } catch (e) {}
    })();
  }, []);

  // Urgent / final stage: full alarm screen, vibration and voice (app open).
  function handleIncomingAlarm(data) {
    const stage = data.stage;
    if (stage === 'urgent' || stage === 'final') {
      setAlarmItem(data);
      setScreen('alarm');
      Vibration.vibrate(stage === 'final' ? [500, 500, 500, 500, 500] : [500, 500]);
      if (data.speak === '1' && data.speakText) {
        Speech.speak(data.speakText, { language: data.speakLang || languageToCode(voiceLang) });
      }
    }
  }

  // The user tapped a notification: urgent ones open the alarm, others open the dashboard.
  function openFromNotification(data) {
    if (data.stage === 'urgent' || data.stage === 'final') {
      setAlarmItem(data);
      setScreen('alarm');
    } else {
      setScreen('dashboard');
    }
  }

  function ackSeen(emailId) {
    if (!emailId) return;
    fetch(`${BACKEND_URL}/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId, action: 'seen' }),
    }).catch(() => {});
  }

  useEffect(() => {
    const messagingInstance = getMessaging(getApp());

    // App is OPEN (foreground): show our custom alarm screen directly, and also
    // raise the native notification so it's consistent with the killed-app case.
    const unsubscribeMsg = onMessage(messagingInstance, async remoteMessage => {
      const data = remoteMessage.data || {};
      if (data.type === 'cancel') {
        Speech.stop();
        if (data.emailId) await notifee.cancelNotification(data.emailId);
        return;
      }
      setLog(l => [data, ...l]);
      await showAlarmNotification(data);
      handleIncomingAlarm(data);
    });

    // User tapped a notification action/body while app was open
    const unsubscribeForeground = notifee.onForegroundEvent(async ({ type, detail }) => {
      if (type === EventType.ACTION_PRESS) {
        const emailId = detail.notification?.data?.emailId;
        if (emailId) {
          await fetch(`${BACKEND_URL}/ack`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emailId, action: detail.pressAction.id, minutes: 20 }),
          }).catch(() => {});
        }
        await notifee.cancelNotification(detail.notification.id);
        setScreen('home');
      } else if (type === EventType.PRESS) {
        const d = detail.notification?.data || {};
        ackSeen(d.emailId);
        if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id);
        openFromNotification(d);
      }
    });

    return () => { unsubscribeMsg(); unsubscribeForeground(); };
  }, [voiceLang]);

  async function registerForPush() {
    setStatusMsg('Requesting notification permission…');
    const messagingInstance = getMessaging(getApp());
    try {
      await notifee.requestPermission();
      const authStatus = await requestPermission(messagingInstance);
      const enabled = authStatus === AuthorizationStatus.AUTHORIZED || authStatus === AuthorizationStatus.PROVISIONAL;
      if (!enabled) {
        setStatusMsg('❌ Notification permission denied. Enable it in phone Settings > Apps > Smart Email Agent > Notifications.');
        return;
      }
    } catch (e) {
      setStatusMsg('❌ Permission request crashed: ' + (e.message || e));
      return;
    }

    let token = null;
    try {
      setStatusMsg('Getting Firebase token…');
      token = await getToken(messagingInstance);
    } catch (e) {
      setStatusMsg('⚠️ Could not get Firebase token (' + (e.message || e) + '). Continuing without it.');
    }

    try {
      setStatusMsg('Connecting to backend at ' + BACKEND_URL + ' …');
      const res = await fetch(`${BACKEND_URL}/register-device`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushToken: token, writtenLang, voiceLang, notifyMode: 'text+voice' }),
      });
      if (!res.ok) {
        setStatusMsg('❌ Backend responded with status ' + res.status + '.');
        return;
      }
      setStatusMsg('✅ Connected to backend' + (token ? ' with a Firebase token.' : ' (no token yet).'));
    } catch (e) {
      setStatusMsg('❌ Could not reach backend at ' + BACKEND_URL + '. (' + (e.message || e) + ')');
    }
  }

  async function fixBackgroundRestrictions() {
    try {
      if (await notifee.isBatteryOptimizationEnabled()) {
        await notifee.openBatteryOptimizationSettings();
        return;
      }
      const info = await notifee.getPowerManagerInfo();
      if (info.activity) await notifee.openPowerManagerSettings();
    } catch (e) {}
  }

  async function saveLanguages() {
    await registerForPush();
    setScreen('home');
  }

  async function respond(action) {
    if (!alarmItem) return;
    try {
      await fetch(`${BACKEND_URL}/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: alarmItem.emailId, action, minutes: 20 }),
      });
    } catch (e) {}
    try { await notifee.cancelNotification(alarmItem.emailId); } catch (e) {}
    Speech.stop();
    setScreen('home');
  }

  if (screen === 'dashboard') {
    return <Dashboard backendUrl={BACKEND_URL} onBack={() => setScreen('home')} />;
  }

  if (screen === 'setup') {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.container}>
        <Text style={styles.h1}>📬 Smart Email Agent</Text>
        <Text style={styles.p}>Choose how you want to read notifications and how you want to hear them.</Text>

        <Text style={styles.label}>Written notification language</Text>
        <View style={styles.chipRow}>
          {WRITTEN_LANGS.map(l => (
            <TouchableOpacity key={l} style={[styles.chip, writtenLang === l && styles.chipActive]} onPress={() => setWrittenLang(l)}>
              <Text style={writtenLang === l ? styles.chipTextActive : styles.chipText}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Voice / spoken language (for critical alerts)</Text>
        <View style={styles.chipRow}>
          {VOICE_LANGS.map(l => (
            <TouchableOpacity key={l} style={[styles.chip, voiceLang === l && styles.chipActive]} onPress={() => setVoiceLang(l)}>
              <Text style={voiceLang === l ? styles.chipTextActive : styles.chipText}>{l}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={saveLanguages}>
          <Text style={styles.primaryBtnText}>Start monitoring my inbox</Text>
        </TouchableOpacity>
        {!!statusMsg && <Text style={styles.statusMsg}>{statusMsg}</Text>}
        <View style={{ height: 60 }} />
      </ScrollView>
    );
  }

  if (screen === 'alarm' && alarmItem) {
    return (
      <View style={[styles.container, styles.alarmBg]}>
        <Text style={styles.alarmTitle}>⏰ {alarmItem.title}</Text>
        <Text style={styles.alarmBody}>{alarmItem.body}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => respond('done')}><Text style={styles.primaryBtnText}>Mark done</Text></TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => respond('snooze')}><Text style={styles.secondaryBtnText}>Snooze 20 min</Text></TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => respond('dismiss')}><Text style={styles.secondaryBtnText}>Dismiss</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.container}>
      <Text style={styles.h1}>📬 Monitoring your inbox</Text>
      <Text style={styles.p}>Written: {writtenLang} · Voice: {voiceLang}</Text>
      {!!statusMsg && <Text style={styles.statusMsg}>{statusMsg}</Text>}
      <TouchableOpacity style={styles.secondaryBtn} onPress={() => setScreen('setup')}><Text style={styles.secondaryBtnText}>Change language</Text></TouchableOpacity>
      <TouchableOpacity style={styles.secondaryBtn} onPress={fixBackgroundRestrictions}><Text style={styles.secondaryBtnText}>Allow alarms when the app is closed</Text></TouchableOpacity>
      <TouchableOpacity style={styles.primaryBtn} onPress={() => setScreen('dashboard')}><Text style={styles.primaryBtnText}>AI accuracy dashboard</Text></TouchableOpacity>
      <Text style={styles.label}>Recent notifications</Text>
      {log.length === 0 && <Text style={styles.p}>Nothing yet — this fills in as classified emails arrive.</Text>}
      {log.map((n, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardTitle}>{n.title}</Text>
          <Text style={styles.p}>{n.body}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function languageToCode(lang) {
  const map = { English: 'en-US', Telugu: 'te-IN', Hindi: 'hi-IN', Tamil: 'ta-IN', Kannada: 'kn-IN', Malayalam: 'ml-IN', Marathi: 'mr-IN', Bengali: 'bn-IN' };
  return map[lang] || 'en-US';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f1115', padding: 20, paddingTop: 60 },
  alarmBg: { backgroundColor: '#3a0d0d', justifyContent: 'center' },
  h1: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  p: { color: '#9aa3b2', fontSize: 14, marginBottom: 14, lineHeight: 20 },
  label: { color: '#9aa3b2', fontSize: 12, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#2a2f3a', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 14, marginRight: 8, marginBottom: 8 },
  chipActive: { backgroundColor: '#6ea8fe', borderColor: '#6ea8fe' },
  chipText: { color: '#e8eaed' },
  chipTextActive: { color: '#0f1115', fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#2a2f3a', borderRadius: 10, padding: 12, color: '#e8eaed', marginBottom: 6 },
  statusMsg: { color: '#f4d03f', fontSize: 13, marginTop: 14, lineHeight: 19 },
  primaryBtn: { backgroundColor: '#6ea8fe', padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 24 },
  primaryBtnText: { color: '#0f1115', fontWeight: '700', fontSize: 16 },
  secondaryBtn: { borderWidth: 1, borderColor: '#2a2f3a', padding: 12, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  secondaryBtnText: { color: '#e8eaed' },
  card: { backgroundColor: '#171a21', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#2a2f3a' },
  cardTitle: { color: '#e8eaed', fontWeight: '600', marginBottom: 4 },
  alarmTitle: { color: '#fff', fontSize: 24, fontWeight: '800', textAlign: 'center', marginBottom: 10 },
  alarmBody: { color: '#ffd7d7', fontSize: 16, textAlign: 'center', marginBottom: 30 },
});