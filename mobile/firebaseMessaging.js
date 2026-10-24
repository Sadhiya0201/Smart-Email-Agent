import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AndroidVisibility, AndroidCategory, EventType } from '@notifee/react-native';
import * as Speech from 'expo-speech';

let channelsReady = false;

// Stages sent by the backend:
//   far         normal notification, no vibration
//   approaching heads-up notification, no vibration
//   urgent      alarm sound + vibration + voice
//   final       same as urgent, and the sound keeps ringing
// (New channel ids so Android applies these settings even if old channels exist.)
export async function ensureChannels() {
  if (channelsReady) return;
  await notifee.createChannel({
    id: 'reminder_v1', name: 'Reminders', importance: AndroidImportance.DEFAULT,
    vibration: false, sound: 'default',
  });
  await notifee.createChannel({
    id: 'approaching_v1', name: 'Deadline approaching', importance: AndroidImportance.HIGH,
    vibration: false, sound: 'default', visibility: AndroidVisibility.PUBLIC,
  });
  await notifee.createChannel({
    id: 'urgent_v1', name: 'Urgent alarms', importance: AndroidImportance.HIGH,
    sound: 'default', vibration: true, vibrationPattern: [300, 500, 300, 500, 300, 500],
    visibility: AndroidVisibility.PUBLIC, bypassDnd: true, lights: true,
  });
  channelsReady = true;
}

const STAGE_CHANNEL = {
  far: 'reminder_v1', approaching: 'approaching_v1', urgent: 'urgent_v1', final: 'urgent_v1',
};

export async function showAlarmNotification(data) {
  await ensureChannels();
  const stage = data.stage || 'far';
  const loud = stage === 'urgent' || stage === 'final';

  await notifee.displayNotification({
    // One notification per email: repeated alerts replace it instead of stacking.
    ...(data.emailId ? { id: data.emailId } : {}),
    title: data.title || 'Smart Email Agent',
    body: data.body || '',
    data,
    android: {
      channelId: STAGE_CHANNEL[stage] || 'reminder_v1',
      importance: stage === 'far' ? AndroidImportance.DEFAULT : AndroidImportance.HIGH,
      category: loud ? AndroidCategory.ALARM : AndroidCategory.REMINDER,
      visibility: AndroidVisibility.PUBLIC,
      loopSound: stage === 'final',
      timeoutAfter: loud ? 3 * 60 * 1000 : undefined,
      // launchActivity is what opens the app from the lock screen / on tap.
      fullScreenAction: loud ? { id: 'default', launchActivity: 'default' } : undefined,
      pressAction: { id: 'default', launchActivity: 'default' },
      actions: [
        { title: 'Dismiss', pressAction: { id: 'dismiss' } },
        { title: 'Snooze 20m', pressAction: { id: 'snooze' } },
      ],
      autoCancel: false,
      ongoing: stage === 'final',
    },
  });
}

// Speaks the alert (works while the app is closed, as long as the phone has a
// text-to-speech voice for the language). Resolves when finished or after 15 s.
export function speakAlert(text, language) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 15000);
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      Speech.speak(text, {
        language: language || 'en-US', rate: 0.95, volume: 1.0,
        onDone: done, onStopped: done, onError: done,
      });
    } catch (e) {
      done();
    }
  });
}

// Runs for every push while the app is in the background or fully closed.
export async function handleAlertData(data) {
  if (data.type === 'cancel') {
    Speech.stop().catch(() => {});
    if (data.emailId) await notifee.cancelNotification(data.emailId);
    return;
  }
  await showAlarmNotification(data);
  if (data.speak === '1' && data.speakText) {
    await speakAlert(data.speakText, data.speakLang);
  }
}

async function ack(BACKEND_URL, emailId, action) {
  if (!emailId) return;
  try {
    await fetch(`${BACKEND_URL}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId, action, minutes: 20 }),
    });
  } catch (e) {}
}

export function registerBackgroundHandlers(BACKEND_URL) {
  setBackgroundMessageHandler(getMessaging(), async remoteMessage => {
    await handleAlertData(remoteMessage.data || {});
  });

  notifee.onBackgroundEvent(async ({ type, detail }) => {
    const emailId = detail.notification?.data?.emailId;
    if (type === EventType.ACTION_PRESS) {
      const action = detail.pressAction?.id;
      if (action === 'dismiss' || action === 'snooze') {
        Speech.stop().catch(() => {});
        await ack(BACKEND_URL, emailId, action);
        await notifee.cancelNotification(detail.notification.id);
      }
    } else if (type === EventType.PRESS) {
      await ack(BACKEND_URL, emailId, 'seen');
    }
  });
}