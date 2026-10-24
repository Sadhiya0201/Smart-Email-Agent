import React, { useCallback, useEffect, useState } from 'react';
import FilteredEmails from './FilteredEmails';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';

const FIELDS = [
  ['event', 'Event'], ['date', 'Date'], ['time', 'Time'],
  ['organization', 'Company'], ['location', 'Location'], ['instructions', 'Instructions'],
];

const STAGE_LABEL = {
  far: 'Normal reminder',
  approaching: 'Deadline approaching',
  urgent: 'Urgent: alarm + voice',
  final: 'Final: alarm + voice, repeating',
};

const pctColor = p => (p == null ? '#9aa3b2' : p >= 90 ? '#4cd964' : p >= 75 ? '#f4d03f' : '#ff6b6b');

function Pct({ value, big }) {
  return (
    <Text style={[big ? styles.pctBig : styles.pct, { color: pctColor(value) }]}>
      {value == null ? '–' : `${value}%`}
    </Text>
  );
}

function Lines({ label, items, color }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={[styles.listLabel, { color }]}>{label}</Text>
      {items.map((t, i) => <Text key={i} style={styles.listItem}>• {t}</Text>)}
    </View>
  );
}

function Report({ title, text, report }) {
  return (
    <View style={styles.report}>
      <View style={styles.row}>
        <Text style={styles.reportTitle}>{title}</Text>
        <Pct value={report ? report.overall : null} />
      </View>
      <Text style={styles.reportText}>{text}</Text>
      {!report && <Text style={styles.muted}>Analysing…</Text>}
      {report && (
        <>
          {FIELDS.map(([k, label]) => (
            typeof report.fields?.[k] === 'number' ? (
              <View key={k} style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>{label}</Text>
                <Text style={[styles.fieldVal, { color: pctColor(report.fields[k]) }]}>{report.fields[k]}%</Text>
              </View>
            ) : null
          ))}
          <Lines label="Matched" items={report.matched} color="#4cd964" />
          <Lines label="Missing" items={report.missing} color="#f4d03f" />
          <Lines label="Incorrect" items={report.incorrect} color="#ff6b6b" />
          <Lines label="Extra (not in the email)" items={report.extra} color="#ffa94d" />
          {!!report.summary && <Text style={styles.muted}>{report.summary}</Text>}
        </>
      )}
    </View>
  );
}

function ItemCard({ item, open, onToggle, onResolve }) {
  const e = item.event;
  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={onToggle}>
        <View style={styles.row}>
          <Text style={styles.cardTitle} numberOfLines={open ? 3 : 1}>{item.subject}</Text>
          <Pct value={item.quality} big />
        </View>
        <Text style={styles.muted}>
          {item.status}{item.stage ? ` · ${STAGE_LABEL[item.stage]}` : ''}
          {item.minutesLeft != null && item.stage ? ` · ${item.minutesLeft} min left` : ''}
        </Text>
        <Text style={styles.when}>{e.event || e.category}{e.organization ? ` · ${e.organization}` : ''} · {e.when}</Text>
      </TouchableOpacity>

      {!!item.pendingMatch && (
        <View style={styles.pending}>
          <Text style={styles.pendingText}>
            Possible update of "{item.pendingMatch.matchSubject}" ({Math.round(item.pendingMatch.confidence * 100)}% sure). Same event?
          </Text>
          <View style={styles.row}>
            <TouchableOpacity style={styles.smallBtn} onPress={() => onResolve(item.id, true)}><Text style={styles.smallBtnText}>Yes, update it</Text></TouchableOpacity>
            <TouchableOpacity style={styles.smallBtnGhost} onPress={() => onResolve(item.id, false)}><Text style={styles.smallBtnGhostText}>No, separate</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {open && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.section}>Original email data</Text>
          <Text style={styles.kv}>From: {item.from}</Text>
          {!!e.location && <Text style={styles.kv}>Where: {e.location}</Text>}
          {!!e.link && <Text style={styles.kv}>Link: {e.link}</Text>}
          {!!e.instructions && <Text style={styles.kv}>Instructions: {e.instructions}</Text>}
          <Text style={styles.excerpt}>{item.originalText}</Text>

          {item.history.length > 0 && (
            <>
              <Text style={styles.section}>Schedule changes</Text>
              {item.history.map((h, i) => (
                <Text key={i} style={styles.kv}>
                  {h.kind}: {h.from}{h.to ? `  →  ${h.to}` : ''}  {h.kind === 'cancelled' ? '(cancelled)' : ''}
                </Text>
              ))}
              <Text style={styles.muted}>Only the latest schedule is used for alerts.</Text>
            </>
          )}

          <Text style={styles.section}>Generated alerts</Text>
          {item.alerts.map((a, i) => (
            <View key={i} style={styles.alertBox}>
              <Text style={styles.alertHead}>
                {STAGE_LABEL[a.stage]} · {new Date(a.at).toLocaleTimeString()}{a.version > 1 ? ` · schedule v${a.version}` : ''}
              </Text>
              <Report title="Notification" text={`${a.title} — ${a.body}`} report={a.analysis?.notification} />
              {!!a.voice && <Report title="Voice alert (transcript)" text={a.voice} report={a.analysis?.voice} />}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function Dashboard({ backendUrl, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState('alerts');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/dashboard`);
      setData(await res.json());
      setError('');
    } catch (e) {
      setError('Could not reach the backend at ' + backendUrl);
    }
  }, [backendUrl]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function resolve(emailId, same) {
    try {
      await fetch(`${backendUrl}/resolve-match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId, same }),
      });
    } catch (e) {}
    load();
  }

  const scored = (data?.items || []).filter(i => i.quality != null);
  const avg = scored.length ? Math.round(scored.reduce((s, i) => s + i.quality, 0) / scored.length) : null;

  if (tab === 'unwanted') {
    return (
      <View style={{ flex: 1, backgroundColor: '#0f1115' }}>
        <View style={styles.tabs}>
          <TouchableOpacity style={styles.tab} onPress={() => setTab('alerts')}><Text style={styles.tabText}>Alerts & accuracy</Text></TouchableOpacity>
          <TouchableOpacity style={[styles.tab, styles.tabOn]}><Text style={[styles.tabText, styles.tabTextOn]}>Unwanted emails</Text></TouchableOpacity>
        </View>
        <FilteredEmails backendUrl={backendUrl} onBack={onBack} embedded />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor="#fff" />}
    >
      <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ Back</Text></TouchableOpacity>
      <View style={styles.tabsInline}>
        <TouchableOpacity style={[styles.tab, styles.tabOn]}><Text style={[styles.tabText, styles.tabTextOn]}>Alerts & accuracy</Text></TouchableOpacity>
        <TouchableOpacity style={styles.tab} onPress={() => setTab('unwanted')}><Text style={styles.tabText}>Unwanted emails</Text></TouchableOpacity>
      </View>
      <Text style={styles.h1}>AI accuracy dashboard</Text>
      <Text style={styles.muted}>How faithfully each alert represents the original email.</Text>

      <View style={styles.summary}>
        <Text style={styles.muted}>Overall quality score</Text>
        <Pct value={avg} big />
        <Text style={styles.muted}>{(data?.items || []).length} events tracked</Text>
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}
      {data && data.items.length === 0 && <Text style={styles.muted}>Nothing yet. Alerts appear here as emails arrive.</Text>}
      {(data?.items || []).map(item => (
        <ItemCard
          key={item.id}
          item={item}
          open={openId === item.id}
          onToggle={() => setOpenId(openId === item.id ? null : item.id)}
          onResolve={resolve}
        />
      ))}
      <View style={{ height: 60 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: 20, paddingTop: 52, gap: 8 },
  tabsInline: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: '#2a2f3a' },
  tabOn: { backgroundColor: '#6ea8fe', borderColor: '#6ea8fe' },
  tabText: { color: '#e8eaed', fontSize: 13 },
  tabTextOn: { color: '#0f1115', fontWeight: '700' },
  container: { flex: 1, backgroundColor: '#0f1115', padding: 20, paddingTop: 60 },
  back: { color: '#6ea8fe', fontSize: 16, marginBottom: 12 },
  h1: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  muted: { color: '#9aa3b2', fontSize: 13, lineHeight: 19 },
  error: { color: '#ff6b6b', marginVertical: 10 },
  summary: { backgroundColor: '#171a21', borderRadius: 12, padding: 14, marginVertical: 14, borderWidth: 1, borderColor: '#2a2f3a', alignItems: 'center' },
  card: { backgroundColor: '#171a21', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#2a2f3a' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: '#e8eaed', fontWeight: '600', fontSize: 15, flex: 1, marginRight: 10 },
  when: { color: '#e8eaed', fontSize: 13, marginTop: 4 },
  pct: { fontSize: 14, fontWeight: '700' },
  pctBig: { fontSize: 22, fontWeight: '800' },
  section: { color: '#9aa3b2', fontSize: 12, textTransform: 'uppercase', marginTop: 14, marginBottom: 6 },
  kv: { color: '#e8eaed', fontSize: 13, marginBottom: 2 },
  excerpt: { color: '#9aa3b2', fontSize: 12, lineHeight: 18, marginTop: 6, fontStyle: 'italic' },
  alertBox: { borderTopWidth: 1, borderTopColor: '#2a2f3a', paddingTop: 8, marginTop: 8 },
  alertHead: { color: '#6ea8fe', fontSize: 12, marginBottom: 4 },
  report: { marginBottom: 8 },
  reportTitle: { color: '#e8eaed', fontWeight: '600', fontSize: 13 },
  reportText: { color: '#e8eaed', fontSize: 13, marginVertical: 4 },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between' },
  fieldLabel: { color: '#9aa3b2', fontSize: 12 },
  fieldVal: { fontSize: 12, fontWeight: '600' },
  listLabel: { fontSize: 12, fontWeight: '700' },
  listItem: { color: '#e8eaed', fontSize: 12, marginLeft: 6 },
  pending: { backgroundColor: '#2a2410', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: '#5a4a10' },
  pendingText: { color: '#f4d03f', fontSize: 13, marginBottom: 8 },
  smallBtn: { backgroundColor: '#6ea8fe', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  smallBtnText: { color: '#0f1115', fontWeight: '700', fontSize: 13 },
  smallBtnGhost: { borderWidth: 1, borderColor: '#2a2f3a', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  smallBtnGhostText: { color: '#e8eaed', fontSize: 13 },
});