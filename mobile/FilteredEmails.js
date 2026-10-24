import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';

export default function FilteredEmails({ backendUrl, onBack, embedded }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${backendUrl}/filtered`);
      const j = await res.json();
      setList(j.filtered || []);
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

  async function clearAll() {
    try { await fetch(`${backendUrl}/filtered`, { method: 'DELETE' }); } catch (e) {}
    load();
  }

  const counts = {};
  (list || []).forEach(m => { counts[m.category] = (counts[m.category] || 0) + 1; });

  return (
    <ScrollView
      style={[styles.container, embedded && { paddingTop: 16 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor="#fff" />}
    >
      {!embedded && <TouchableOpacity onPress={onBack}><Text style={styles.back}>‹ Back</Text></TouchableOpacity>}
      <Text style={styles.h1}>Unwanted emails</Text>
      <Text style={styles.muted}>Emails the AI judged promotional, social or needing no action. They never trigger alerts.</Text>

      <View style={styles.summary}>
        <Text style={styles.count}>{list ? list.length : '–'}</Text>
        <Text style={styles.muted}>filtered so far</Text>
        {Object.keys(counts).length > 0 && (
          <Text style={styles.muted}>{Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}</Text>
        )}
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}
      {list && list.length === 0 && <Text style={styles.muted}>Nothing yet. Only emails that arrive after you started monitoring appear here.</Text>}

      {(list || []).map((m, i) => (
        <View key={m.emailId + i} style={styles.card}>
          <Text style={styles.subject} numberOfLines={2}>{m.subject}</Text>
          <Text style={styles.muted} numberOfLines={1}>{m.from}</Text>
          <Text style={styles.tag}>{m.category} · {new Date(m.at).toLocaleString()}</Text>
          {!!m.snippet && <Text style={styles.snippet} numberOfLines={3}>{m.snippet}</Text>}
        </View>
      ))}

      {list && list.length > 0 && (
        <TouchableOpacity style={styles.clearBtn} onPress={clearAll}><Text style={styles.clearText}>Clear list</Text></TouchableOpacity>
      )}
      <View style={{ height: 60 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f1115', padding: 20, paddingTop: 60 },
  back: { color: '#6ea8fe', fontSize: 16, marginBottom: 12 },
  h1: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  muted: { color: '#9aa3b2', fontSize: 13, lineHeight: 19 },
  error: { color: '#ff6b6b', marginVertical: 10 },
  summary: { backgroundColor: '#171a21', borderRadius: 12, padding: 14, marginVertical: 14, borderWidth: 1, borderColor: '#2a2f3a', alignItems: 'center' },
  count: { color: '#fff', fontSize: 28, fontWeight: '800' },
  card: { backgroundColor: '#171a21', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#2a2f3a' },
  subject: { color: '#e8eaed', fontWeight: '600', fontSize: 15, marginBottom: 2 },
  tag: { color: '#6ea8fe', fontSize: 12, marginTop: 4 },
  snippet: { color: '#9aa3b2', fontSize: 12, lineHeight: 18, marginTop: 6 },
  clearBtn: { borderWidth: 1, borderColor: '#2a2f3a', borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 8 },
  clearText: { color: '#e8eaed', fontSize: 14 },
});