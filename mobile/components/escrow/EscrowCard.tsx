import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import Badge from '../ui/Badge';
import Card from '../ui/Card';
import { truncateAddress, stroopsToXlm } from '../../lib/stellar';
import type { Escrow } from '../../lib/api';
import { getCacheFreshnessLabel, getEscrowDeadlineState } from '../../lib/escrowFreshness';

interface EscrowCardProps {
  escrow: Escrow;
  userAddress: string;
}

export default function EscrowCard({ escrow, userAddress }: EscrowCardProps) {
  const router = useRouter();
  const isClient = escrow.clientAddress === userAddress;
  const counterparty = isClient ? escrow.freelancerAddress : escrow.clientAddress;

  const milestones = escrow.milestones ?? [];
  const approved = milestones.filter((m) => m.status === 'Approved').length;
  const total = milestones.length;
  const progressPct = total > 0 ? (approved / total) * 100 : 0;
  const deadlineState = getEscrowDeadlineState(escrow.deadline);
  const freshnessLabel = getCacheFreshnessLabel((escrow as Escrow & { cachedAt?: string }).cachedAt);

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={() => router.push(`/escrow/${escrow.id}`)}>
      <Card style={styles.card}>
        {/* Header */}
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={styles.id} numberOfLines={1}>
              Escrow #{escrow.id}
            </Text>
            <Text style={styles.counterparty} numberOfLines={1}>
              {isClient ? 'Freelancer: ' : 'Client: '}
              <Text style={styles.mono}>{truncateAddress(counterparty)}</Text>
            </Text>
          </View>
          <Badge status={escrow.status} size="sm" />
        </View>

        {/* Amount */}
        <Text style={styles.amount}>{stroopsToXlm(escrow.totalAmount)} XLM</Text>

        {/* Milestone progress */}
        {total > 0 && (
          <View style={styles.progressSection}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>Milestones</Text>
              <Text style={styles.progressLabel}>
                {approved} / {total}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
            </View>
          </View>
        )}

        {/* Footer */}
        <View style={[styles.row, styles.footer]}>
          <Text style={styles.role}>
            You are{' '}
            <Text style={isClient ? styles.clientRole : styles.freelancerRole}>
              {isClient ? 'client' : 'freelancer'}
            </Text>
          </Text>
          {deadlineState.label && (
            <Text style={[styles.deadline, deadlineState.isExpired && styles.expired]}>
              {deadlineState.label}
            </Text>
          )}
        </View>
        {freshnessLabel && <Text style={styles.staleCache}>{freshnessLabel}</Text>}
      </Card>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  flex: { flex: 1, marginRight: 8 },
  id: { fontSize: 15, fontWeight: '700', color: '#f9fafb' },
  counterparty: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  mono: { fontFamily: 'monospace', color: '#9ca3af' },
  amount: { fontSize: 22, fontWeight: '800', color: '#fff', marginVertical: 10 },
  progressSection: { marginBottom: 10 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  progressLabel: { fontSize: 11, color: '#6b7280' },
  progressTrack: { height: 4, backgroundColor: '#1f2937', borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#6366f1', borderRadius: 999 },
  footer: { borderTopWidth: 1, borderTopColor: '#1f2937', paddingTop: 10, marginTop: 4 },
  role: { fontSize: 12, color: '#6b7280' },
  clientRole: { color: '#60a5fa', fontWeight: '600' },
  freelancerRole: { color: '#34d399', fontWeight: '600' },
  deadline: { fontSize: 11, color: '#6b7280' },
  expired: { color: '#f87171', fontWeight: '700' },
  staleCache: { color: '#f59e0b', fontSize: 11, marginTop: 8 },
});
