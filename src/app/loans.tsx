
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Borrower = {
  id: number;
  full_name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
};

type Loan = {
  id: number;
  borrower_id: number;
  borrower_name: string;
  principal: number;
  interest_type: 'fixed' | 'percentage';
  interest_value: number;
  interest_amount: number;
  total_due: number;
  start_date: string;
  due_date: string | null;
  status: string;
  paid_amount: number;
  balance: number;
  penalty_amount: number;
  overdue_days: number;
};

type Payment = {
  id: number;
  loan_id: number;
  borrower_name: string;
  amount: number;
  payment_date: string;
  method: string;
  reference: string | null;
};

type Tab = 'Borrowers' | 'Loans' | 'Payments';

const peso = (amount: number) =>
  '₱' + Number(amount || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const today = () => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

// Date-only arithmetic in UTC avoids time-zone and daylight-saving shifts.
const daysBetween = (start: string, end: string) => {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.floor((endMs - startMs) / 86400000);
};

const fieldStyle = {
  backgroundColor: '#1A1B1E',
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 11,
  color: '#F3F4F6',
  marginTop: 6,
  marginBottom: 12,
} as const;

export default function LoansScreen() {
  const db = useSQLiteContext();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('Borrowers');
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [penaltyPerDay, setPenaltyPerDay] = useState(100);
  const [penaltyInput, setPenaltyInput] = useState('100');
  const [savingPenalty, setSavingPenalty] = useState(false);

  const [modal, setModal] = useState<
    'borrower' | 'loan' | 'payment' | null
  >(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');

  const [borrowerId, setBorrowerId] = useState<number | null>(null);
  const [principal, setPrincipal] = useState('');
  const [interestType, setInterestType] =
    useState<'fixed' | 'percentage'>('fixed');
  const [interestValue, setInterestValue] = useState('0');
  const [startDate, setStartDate] = useState(today());
  const [dueDate, setDueDate] = useState('');

  const [selectedLoanId, setSelectedLoanId] = useState<number | null>(null);
  const [detailLoanId, setDetailLoanId] = useState<number | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [reference, setReference] = useState('');

  const refresh = useCallback(async () => {
    try {
      // Create the default setting on first use, then read it from SQLite.
      let setting = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?',
        'late_penalty_per_day'
      );

      if (!setting) {
        await db.runAsync(
          'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
          'late_penalty_per_day',
          '100'
        );
        setting = { value: '100' };
      }

      const parsedPenalty = Number(setting.value);
      const dailyPenalty = Number.isFinite(parsedPenalty) && parsedPenalty >= 0
        ? parsedPenalty
        : 100;
      setPenaltyPerDay(dailyPenalty);
      setPenaltyInput(String(dailyPenalty));

      const b = await db.getAllAsync<Borrower>(
        'SELECT * FROM borrowers ORDER BY full_name COLLATE NOCASE'
      );

      const rawLoans = await db.getAllAsync<Loan>(`
        SELECT
          l.*,
          b.full_name AS borrower_name,
          COALESCE(SUM(p.amount), 0) AS paid_amount,
          MAX(0, l.total_due - COALESCE(SUM(p.amount), 0)) AS balance,
          0 AS penalty_amount,
          0 AS overdue_days
        FROM loans l
        JOIN borrowers b ON b.id = l.borrower_id
        LEFT JOIN payments p ON p.loan_id = l.id
        GROUP BY l.id
        ORDER BY l.id DESC
      `);

      const p = await db.getAllAsync<Payment>(`
        SELECT
          p.*,
          b.full_name AS borrower_name
        FROM payments p
        JOIN loans l ON l.id = p.loan_id
        JOIN borrowers b ON b.id = l.borrower_id
        ORDER BY p.payment_date DESC, p.id DESC
      `);

      // Accrue one penalty for each day after the due date while the
      // original total_due remains unpaid. Freeze accrual on the date
      // payments first cover total_due, so the penalty cannot grow forever.
      const calculatedLoans = rawLoans.map((loan) => {
        let cutoffDate = today();

        if (loan.paid_amount >= loan.total_due - 0.001) {
          const chronologicalPayments = p
            .filter(payment => payment.loan_id === loan.id)
            .slice()
            .sort((a, b) =>
              a.payment_date.localeCompare(b.payment_date) || a.id - b.id
            );

          let cumulativePaid = 0;
          const payoffPayment = chronologicalPayments.find(payment => {
            cumulativePaid += payment.amount;
            return cumulativePaid >= loan.total_due - 0.001;
          });

          if (payoffPayment) cutoffDate = payoffPayment.payment_date;
        }

        const overdueDays = loan.due_date
          ? daysBetween(loan.due_date, cutoffDate)
          : 0;
        const penaltyAmount = Math.round(overdueDays * dailyPenalty * 100) / 100;
        const balance = Math.max(
          0,
          Math.round((loan.total_due + penaltyAmount - loan.paid_amount) * 100) / 100
        );

        let status = loan.status;
        if (status !== 'cancelled') {
          if (balance <= 0.001) status = 'paid';
          else if (loan.due_date && today() > loan.due_date) status = 'overdue';
          else status = 'active';
        }

        return { ...loan, penalty_amount: penaltyAmount, overdue_days: overdueDays, balance, status };
      });

      setBorrowers(b);
      setLoans(calculatedLoans);
      setPayments(p);
    } catch (error) {
      console.error('Database refresh failed:', error);
      Alert.alert(
        'Database error',
        'Could not load your records. Check that Step 3 database setup is complete and the settings table exists.'
      );
    } finally {
      setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep local reminders synchronized with the saved loan list. The dashboard
  // requests permission; this effect schedules reminders only when allowed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const permission = await Notifications.getPermissionsAsync();
        if (!permission.granted || cancelled || loans.length === 0) return;

        const existing = await Notifications.getAllScheduledNotificationsAsync();
        for (const item of existing) {
          if (item.content.data?.emergencyLoanReminder === true) {
            await Notifications.cancelScheduledNotificationAsync(item.identifier);
          }
        }

        const now = new Date();
        for (const loan of loans) {
          if (cancelled || !loan.due_date || loan.balance <= 0.001 || loan.status === 'cancelled') continue;
          const due = new Date(`${loan.due_date}T09:00:00`);
          if (Number.isNaN(due.getTime())) continue;
          for (const daysBefore of [3, 1, 0]) {
            const fireAt = new Date(due);
            fireAt.setDate(fireAt.getDate() - daysBefore);
            if (fireAt <= now) continue;
            const dueLabel = daysBefore === 0 ? 'is due today' : `is due in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`;
            const penaltyLabel = loan.penalty_amount > 0 ? ` Current penalty: ${peso(loan.penalty_amount)}.` : ' Current penalty: ₱0.00.';
            await Notifications.scheduleNotificationAsync({
              content: {
                title: `Loan due: ${loan.borrower_name}`,
                body: `Loan #${loan.id} ${dueLabel}. Principal: ${peso(loan.principal)}. Total before penalty: ${peso(loan.total_due)}. Balance: ${peso(loan.balance)}.${penaltyLabel} Due date: ${loan.due_date}.`,
                data: { emergencyLoanReminder: true, loanId: loan.id },
              },
              trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
            });
          }
        }
      } catch (error) {
        console.warn('Could not schedule loan due reminders:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [loans]);

  const resetForm = () => {
    setName('');
    setPhone('');
    setAddress('');
    setNotes('');
    setBorrowerId(null);
    setPrincipal('');
    setInterestType('fixed');
    setInterestValue('0');
    setStartDate(today());
    setDueDate('');
    setSelectedLoanId(null);
    setPaymentAmount('');
    setPaymentDate(today());
    setPaymentMethod('cash');
    setReference('');
  };

  const closeModal = () => {
    setModal(null);
    resetForm();
  };

  const openModal = (next: 'borrower' | 'loan' | 'payment') => {
    resetForm();
    setModal(next);
  };

  const savePenaltySetting = async () => {
    const amount = Number(penaltyInput.trim());

    if (!penaltyInput.trim() || !Number.isFinite(amount) || amount < 0) {
      Alert.alert('Invalid penalty', 'Enter a valid daily penalty amount of ₱0 or more.');
      return;
    }

    const roundedAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
    setSavingPenalty(true);
    try {
      await db.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        'late_penalty_per_day',
        String(roundedAmount)
      );
      setPenaltyPerDay(roundedAmount);
      setPenaltyInput(String(roundedAmount));
      await refresh();
      Alert.alert('Penalty updated', `Late penalty saved as ${peso(roundedAmount)} per overdue day.`);
    } catch (error) {
      console.error('Could not save late penalty setting:', error);
      Alert.alert('Error', 'Could not save the penalty setting.');
    } finally {
      setSavingPenalty(false);
    }
  };

  const saveBorrower = async () => {
    if (!name.trim()) {
      Alert.alert('Required', 'Enter the borrower’s full name.');
      return;
    }

    setSaving(true);
    try {
      await db.runAsync(
        `INSERT INTO borrowers
          (full_name, phone, address, notes, updated_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        name.trim(),
        phone.trim() || null,
        address.trim() || null,
        notes.trim() || null
      );

      closeModal();
      await refresh();
      Alert.alert('Saved', 'Borrower registered successfully.');
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Could not save the borrower.');
    } finally {
      setSaving(false);
    }
  };

  const saveLoan = async () => {
    const amount = Number(principal);
    const rate = Number(interestValue);

    if (!borrowerId) {
      Alert.alert('Select borrower', 'Choose a borrower first.');
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Invalid amount', 'Principal must be greater than zero.');
      return;
    }

    if (!Number.isFinite(rate) || rate < 0) {
      Alert.alert('Invalid interest', 'Interest cannot be negative.');
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      Alert.alert('Invalid date', 'Use YYYY-MM-DD for the start date.');
      return;
    }

    if (
      dueDate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < startDate)
    ) {
      Alert.alert(
        'Invalid due date',
        'Enter a valid due date on or after the start date.'
      );
      return;
    }

    // Fixed interest means a fixed peso amount.
    // Percentage interest is a one-time percentage of principal.
    const interest = interestType === 'fixed'
      ? rate
      : amount * rate / 100;

    const total = Math.round((amount + interest + Number.EPSILON) * 100) / 100;

    setSaving(true);
    try {
      await db.runAsync(
        `INSERT INTO loans (
          borrower_id, principal, interest_type, interest_value,
          interest_amount, total_due, start_date, due_date, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        borrowerId,
        amount,
        interestType,
        rate,
        interest,
        total,
        startDate,
        dueDate || null,
        notes.trim() || null
      );

      closeModal();
      await refresh();
      Alert.alert(
        'Loan created',
        `Total due: ${peso(total)}\nInterest: ${peso(interest)}`
      );
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Could not create the loan.');
    } finally {
      setSaving(false);
    }
  };

  const savePayment = async () => {
    const loan = loans.find(item => item.id === selectedLoanId);
    const amount = Number(paymentAmount);

    if (!loan) {
      Alert.alert('Select loan', 'Choose a loan to record its payment.');
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Invalid payment', 'Enter a payment greater than zero.');
      return;
    }

    if (amount > loan.balance + 0.001) {
      Alert.alert(
        'Payment too high',
        `The outstanding balance is ${peso(loan.balance)}.`
      );
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
      Alert.alert('Invalid date', 'Use YYYY-MM-DD for the payment date.');
      return;
    }

    setSaving(true);
    try {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `INSERT INTO payments
            (loan_id, amount, payment_date, method, reference, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          loan.id,
          Math.round(amount * 100) / 100,
          paymentDate,
          paymentMethod.trim() || 'cash',
          reference.trim() || null,
          notes.trim() || null
        );

        const result = await db.getFirstAsync<{ paid: number }>(
          'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE loan_id = ?',
          loan.id
        );

        const paid = result?.paid ?? 0;
        const status = paid >= loan.total_due + loan.penalty_amount - 0.001 ? 'paid' : 'active';

        await db.runAsync(
          `UPDATE loans
           SET status = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`,
          status,
          loan.id
        );
      });

      closeModal();
      await refresh();
      Alert.alert('Payment recorded', `Payment: ${peso(amount)}`);
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Could not save the payment.');
    } finally {
      setSaving(false);
    }
  };

  const card = {
    backgroundColor: '#292B2F',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#484B50',
  } as const;

  const label = {
    fontSize: 12,
    fontWeight: '700' as const,
    color: '#AEB1B7',
  };

  const mainText = {
    color: '#F3F4F6',
  };

  const primaryButton = {
    backgroundColor: '#777B83',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  const input = (value: string, setter: (v: string) => void, placeholder: string, numeric = false) => (
    <TextInput
      value={value}
      onChangeText={setter}
      placeholder={placeholder}
      placeholderTextColor="#858990"
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      style={fieldStyle}
    />
  );

  const choose = (selected: boolean) => ({
    padding: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: selected ? '#AEB1B7' : '#55585E',
    backgroundColor: selected ? '#45484D' : '#292B2F',
    marginRight: 8,
    marginBottom: 8,
  });

  const modalTitle = modal === 'borrower'
    ? 'Register Borrower'
    : modal === 'loan'
      ? 'Create Loan'
      : 'Record Payment';

  return (
    <LinearGradient colors={['#111214', '#292B2F', '#17181A']} style={{ flex: 1 }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: 'transparent' }}>
      <View style={{ padding: 16, paddingBottom: 8 }}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            marginBottom: 14,
            paddingVertical: 10,
            paddingHorizontal: 15,
            borderRadius: 10,
            backgroundColor: pressed ? '#45484D' : '#292B2F',
            borderWidth: 1,
            borderColor: '#484B50',
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ color: '#F3F4F6', fontWeight: '800' }}>
            Back to dashboard
          </Text>
        </Pressable>

        <Text style={{ fontSize: 25, fontWeight: '800', ...mainText }}>
          Loan Management
        </Text>

      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 8 }}>
        <View style={{ ...card, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', ...mainText }}>
            Late-payment penalty
          </Text>
          <Text style={{ color: '#AEB1B7', marginTop: 5, lineHeight: 19 }}>
            Charge this amount for each overdue day. The default is ₱100 per day.
          </Text>
          <Text style={label}>PENALTY PER OVERDUE DAY (PHP)</Text>
          <TextInput
            value={penaltyInput}
            onChangeText={setPenaltyInput}
            placeholder="100"
            placeholderTextColor="#858990"
            keyboardType="decimal-pad"
            style={fieldStyle}
          />
          <Pressable
            disabled={savingPenalty}
            onPress={savePenaltySetting}
            style={{ ...primaryButton, opacity: savingPenalty ? 0.6 : 1 }}
          >
            <Text style={{ color: '#292B2F', fontWeight: '800' }}>
              {savingPenalty ? 'Saving penalty...' : 'Save penalty setting'}
            </Text>
          </Pressable>
          <Text style={{ color: '#AEB1B7', fontSize: 12, marginTop: 8 }}>
            Current setting: {peso(penaltyPerDay)} per overdue day
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {([
            ['Borrowers', borrowers.length],
            ['Loans', loans.length],
            ['Payments', payments.length],
          ] as [Tab, number][]).map(([item, count]) => (
            <Pressable
              key={item}
              onPress={() => setTab(item)}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 11,
                alignItems: 'center',
                backgroundColor: tab === item ? '#777B83' : '#292B2F',
                borderWidth: 1,
                borderColor: tab === item ? '#777B83' : '#484B50',
              }}
            >
              <Text style={{
                fontWeight: '800',
                color: tab === item ? '#292B2F' : '#D1D5DB',
              }}>
                {item}
              </Text>
              <Text style={{
                marginTop: 3,
                color: tab === item ? '#45484D' : '#AEB1B7',
                fontSize: 12,
              }}>
                {count} records
              </Text>
            </Pressable>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator size="large" color="#777B83" />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
              <View style={{ ...card, flex: 1 }}>
                <Text style={label}>TOTAL LOAN BALANCE</Text>
                <Text style={{ color: '#777B83', fontWeight: '800', fontSize: 17, marginTop: 8 }}>
                  {peso(loans.reduce((sum, item) => sum + item.balance, 0))}
                </Text>
              </View>
              <View style={{ ...card, flex: 1 }}>
                <Text style={label}>TOTAL COLLECTED</Text>
                <Text style={{ color: '#86EFAC', fontWeight: '800', fontSize: 17, marginTop: 8 }}>
                  {peso(payments.reduce((sum, item) => sum + item.amount, 0))}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={() => openModal(
                tab === 'Borrowers' ? 'borrower' :
                tab === 'Loans' ? 'loan' : 'payment'
              )}
              style={{ ...primaryButton, marginBottom: 16 }}
            >
              <Text style={{ color: '#292B2F', fontWeight: '800' }}>
                {tab === 'Borrowers' ? '+ Register Borrower' :
                 tab === 'Loans' ? '+ Create Loan' : '+ Record Payment'}
              </Text>
            </Pressable>

            {tab === 'Borrowers' && (
              <View style={{ maxHeight: 420, borderRadius: 12, overflow: 'hidden' }}>
                <ScrollView nestedScrollEnabled showsVerticalScrollIndicator persistentScrollbar contentContainerStyle={{ paddingRight: 6 }}>
              {borrowers.length === 0 ? (
                <Text style={{ textAlign: 'center', color: '#AEB1B7', padding: 24 }}>
                  No borrowers yet. Register your first borrower.
                </Text>
              ) : borrowers.map(b => (
                <View key={b.id} style={card}>
                  <Text style={{ fontSize: 16, fontWeight: '800', ...mainText }}>
                    {b.full_name}
                  </Text>
                  <Text style={{ color: '#AEB1B7', marginTop: 5 }}>
                    {b.phone || 'No phone number'}
                  </Text>
                  {!!b.address && (
                    <Text style={{ color: '#AEB1B7', marginTop: 3 }}>
                      {b.address}
                    </Text>
                  )}
                  {!!b.notes && (
                    <Text style={{ color: '#AEB1B7', marginTop: 3 }}>
                      {b.notes}
                    </Text>
                  )}
                  <Pressable
                    onPress={() => {
                      setBorrowerId(b.id);
                      setModal('loan');
                    }}
                    style={{ marginTop: 12 }}
                  >
                    <Text style={{ color: '#777B83', fontWeight: '700' }}>
                      + Create loan for this borrower
                    </Text>
                  </Pressable>
                </View>
              ))}
                </ScrollView>
              </View>
            )}

            {tab === 'Loans' && (
              <View style={{ maxHeight: 420, borderRadius: 12, overflow: 'hidden' }}>
                <ScrollView nestedScrollEnabled showsVerticalScrollIndicator persistentScrollbar contentContainerStyle={{ paddingRight: 6 }}>
              {loans.length === 0 ? (
                <Text style={{ textAlign: 'center', color: '#AEB1B7', padding: 24 }}>
                  No loans yet. Register a borrower first, then create a loan.
                </Text>
              ) : loans.map(l => (
                <View key={l.id} style={card}>
                  <Text style={{ fontSize: 16, fontWeight: '800', ...mainText }}>
                    {l.borrower_name}
                  </Text>
                  <Text style={{ color: '#AEB1B7', marginTop: 5 }}>
                    Loan #{l.id} · {l.status.toUpperCase()}
                  </Text>
                  <View style={{ marginTop: 10, gap: 5 }}>
                    <Text style={mainText}>Principal: {peso(l.principal)}</Text>
                    <Text style={mainText}>
                      Interest: {peso(l.interest_amount)} ({
                        l.interest_type === 'fixed'
                          ? 'fixed'
                          : `${l.interest_value}%`
                      })
                    </Text>
                    <Text style={mainText}>Total due before penalty: {peso(l.total_due)}</Text>
                    {l.penalty_amount > 0 && (
                      <Text style={{ color: '#F87171', fontWeight: '700' }}>
                        Late penalty: {peso(l.penalty_amount)} ({l.overdue_days} overdue day{l.overdue_days === 1 ? '' : 's'} × {peso(penaltyPerDay)})
                      </Text>
                    )}
                    <Text style={{ color: '#86EFAC', fontWeight: '800' }}>
                      Paid: {peso(l.paid_amount)}
                    </Text>
                    <Text style={{ color: '#777B83', fontWeight: '800', fontSize: 16 }}>
                      Balance: {peso(l.balance)}
                    </Text>
                    <Text style={{ color: '#AEB1B7' }}>
                      Start: {l.start_date}
                      {l.due_date ? ` · Due: ${l.due_date}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setDetailLoanId(l.id)}
                    style={{ marginTop: 12, paddingVertical: 9 }}
                  >
                    <Text style={{ color: '#777B83', fontWeight: '800' }}>
                      View loan details and payment history ›
                    </Text>
                  </Pressable>
                  {l.balance > 0.001 && l.status !== 'cancelled' && (
                    <Pressable
                      onPress={() => {
                        setSelectedLoanId(l.id);
                        setModal('payment');
                      }}
                      style={{ marginTop: 4 }}
                    >
                      <Text style={{ color: '#777B83', fontWeight: '800' }}>
                        + Record payment
                      </Text>
                    </Pressable>
                  )}
                </View>
              ))}
                </ScrollView>
              </View>
            )}

            {tab === 'Payments' && (
              <View style={{ maxHeight: 420, borderRadius: 12, overflow: 'hidden' }}>
                <ScrollView nestedScrollEnabled showsVerticalScrollIndicator persistentScrollbar contentContainerStyle={{ paddingRight: 6 }}>
              {payments.length === 0 ? (
                <Text style={{ textAlign: 'center', color: '#AEB1B7', padding: 24 }}>
                  No payments recorded yet.
                </Text>
              ) : payments.map(p => (
                <View key={p.id} style={card}>
                  <Text style={{ fontSize: 16, fontWeight: '800', color: '#86EFAC' }}>
                    +{peso(p.amount)}
                  </Text>
                  <Text style={{ ...mainText, marginTop: 5 }}>
                    {p.borrower_name}
                  </Text>
                  <Text style={{ color: '#AEB1B7', marginTop: 4 }}>
                    Loan #{p.loan_id} · {p.payment_date}
                  </Text>
                  <Text style={{ color: '#AEB1B7', marginTop: 3 }}>
                    Method: {p.method}
                    {p.reference ? ` · Ref: ${p.reference}` : ''}
                  </Text>
                </View>
              ))}
                </ScrollView>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <Modal
        visible={detailLoanId !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setDetailLoanId(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#17181A', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, maxHeight: '92%' }}>
            {(() => {
              const loan = loans.find(item => item.id === detailLoanId);
              const history = payments.filter(item => item.loan_id === detailLoanId)
                .slice().sort((a, b) => b.payment_date.localeCompare(a.payment_date) || b.id - a.id);
              if (!loan) {
                return <Text style={{ color: '#F3F4F6', padding: 20 }}>Loan not found. Close and refresh the loan list.</Text>;
              }
              return (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={{ color: '#F3F4F6', fontSize: 21, fontWeight: '800' }}>Loan #{loan.id}</Text>
                      <Text style={{ color: '#AEB1B7', marginTop: 3 }}>{loan.borrower_name}</Text>
                    </View>
                    <Pressable onPress={() => setDetailLoanId(null)} style={{ padding: 10 }}>
                      <Text style={{ color: '#777B83', fontWeight: '800' }}>Close ✕</Text>
                    </Pressable>
                  </View>
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <View style={card}>
                      <Text style={{ color: '#AEB1B7', fontSize: 12, fontWeight: '700' }}>LOAN SUMMARY</Text>
                      <Text style={{ ...mainText, marginTop: 10 }}>Status: {loan.status.toUpperCase()}</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Principal: {peso(loan.principal)}</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Interest: {peso(loan.interest_amount)} ({loan.interest_type === 'fixed' ? 'fixed amount' : `${loan.interest_value}%`})</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Original total due: {peso(loan.total_due)}</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Start date: {loan.start_date}</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Due date: {loan.due_date || 'No due date set'}</Text>
                      <Text style={{ ...mainText, marginTop: 7 }}>Overdue days: {loan.overdue_days}</Text>
                      <Text style={{ color: '#F87171', marginTop: 7, fontWeight: '700' }}>Accumulated penalty: {peso(loan.penalty_amount)}</Text>
                      <Text style={{ color: '#86EFAC', marginTop: 7, fontWeight: '700' }}>Total payments: {peso(loan.paid_amount)}</Text>
                      <Text style={{ color: '#777B83', fontSize: 20, fontWeight: '900', marginTop: 10 }}>Outstanding balance: {peso(loan.balance)}</Text>
                    </View>
                    <View style={{ ...card, marginTop: 2 }}>
                      <Text style={{ color: '#F3F4F6', fontSize: 17, fontWeight: '800' }}>Payment history</Text>
                      <Text style={{ color: '#AEB1B7', marginTop: 4, marginBottom: 10 }}>{history.length} payment record{history.length === 1 ? '' : 's'}</Text>
                      {history.length === 0 ? (
                        <Text style={{ color: '#AEB1B7', paddingVertical: 12 }}>No payments have been recorded for this loan.</Text>
                      ) : history.map(payment => (
                        <View key={payment.id} style={{ paddingVertical: 11, borderTopWidth: 1, borderTopColor: '#484B50' }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                            <Text style={{ color: '#86EFAC', fontWeight: '800', flexShrink: 1 }}>{peso(payment.amount)}</Text>
                            <Text style={{ color: '#AEB1B7' }}>{payment.payment_date}</Text>
                          </View>
                          <Text style={{ color: '#D1D5DB', marginTop: 4 }}>Method: {payment.method || 'Not specified'}</Text>
                          {!!payment.reference && <Text style={{ color: '#AEB1B7', marginTop: 3 }}>Reference: {payment.reference}</Text>}
                        </View>
                      ))}
                    </View>
                    {loan.balance > 0.001 && loan.status !== 'cancelled' && (
                      <Pressable
                        onPress={() => { setDetailLoanId(null); setSelectedLoanId(loan.id); setModal('payment'); }}
                        style={{ ...primaryButton, marginBottom: 16 }}
                      >
                        <Text style={{ color: '#292B2F', fontWeight: '800' }}>+ Record payment for this loan</Text>
                      </Pressable>
                    )}
                  </ScrollView>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      <Modal
        visible={modal !== null}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <View style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.72)',
          justifyContent: 'flex-end',
        }}>
          <View style={{
            backgroundColor: '#292B2F',
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
            padding: 20,
            maxHeight: '90%',
          }}>
            <Text style={{
              fontSize: 21,
              fontWeight: '800',
              color: '#F3F4F6',
              marginBottom: 16,
            }}>
              {modalTitle}
            </Text>

            <ScrollView keyboardShouldPersistTaps="handled">
              {modal === 'borrower' && (
                <>
                  <Text style={label}>FULL NAME *</Text>
                  {input(name, setName, 'Borrower full name')}
                  <Text style={label}>PHONE NUMBER</Text>
                  {input(phone, setPhone, 'Phone number')}
                  <Text style={label}>ADDRESS</Text>
                  {input(address, setAddress, 'Address')}
                  <Text style={label}>NOTES</Text>
                  {input(notes, setNotes, 'Optional notes')}
                </>
              )}

              {modal === 'loan' && (
                <>
                  <Text style={label}>BORROWER *</Text>
                  {borrowers.length === 0 ? (
                    <Text style={{ color: '#F87171', marginVertical: 12 }}>
                      Register a borrower before creating a loan.
                    </Text>
                  ) : borrowers.map(b => (
                    <Pressable
                      key={b.id}
                      onPress={() => setBorrowerId(b.id)}
                      style={choose(borrowerId === b.id)}
                    >
                      <Text style={{
                        color: borrowerId === b.id ? '#777B83' : '#F3F4F6',
                        fontWeight: '700',
                      }}>
                        {b.full_name}
                      </Text>
                    </Pressable>
                  ))}

                  <Text style={label}>PRINCIPAL AMOUNT (PHP) *</Text>
                  {input(principal, setPrincipal, 'e.g. 5000', true)}

                  <Text style={label}>INTEREST TYPE</Text>
                  <View style={{ flexDirection: 'row' }}>
                    <Pressable
                      onPress={() => setInterestType('fixed')}
                      style={choose(interestType === 'fixed')}
                    >
                      <Text style={{ color: '#F3F4F6' }}>Fixed amount ₱</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setInterestType('percentage')}
                      style={choose(interestType === 'percentage')}
                    >
                      <Text style={{ color: '#F3F4F6' }}>Percentage %</Text>
                    </Pressable>
                  </View>

                  <Text style={label}>
                    {interestType === 'fixed' ? 'INTEREST AMOUNT (PHP)' : 'INTEREST RATE (%)'}
                  </Text>
                  {input(interestValue, setInterestValue, 'e.g. 10', true)}

                  <View style={{ backgroundColor: '#383A3F', padding: 12, borderRadius: 10, marginBottom: 12 }}>
                    <Text style={{ color: '#E5E7EB' }}>
                      Interest: {peso(
                        interestType === 'fixed'
                          ? Math.max(0, Number(interestValue) || 0)
                          : Math.max(0, Number(principal) || 0) *
                            Math.max(0, Number(interestValue) || 0) / 100
                      )}
                    </Text>
                    <Text style={{ color: '#E5E7EB', fontWeight: '800', marginTop: 5 }}>
                      Total due: {peso(
                        Math.max(0, Number(principal) || 0) +
                        (interestType === 'fixed'
                          ? Math.max(0, Number(interestValue) || 0)
                          : Math.max(0, Number(principal) || 0) *
                            Math.max(0, Number(interestValue) || 0) / 100)
                      )}
                    </Text>
                    <Text style={{ color: '#E5E7EB', fontSize: 12, marginTop: 5 }}>
                      Percentage interest is a one-time rate on the principal, not a monthly rate.
                    </Text>
                  </View>

                  <Text style={label}>START DATE (YYYY-MM-DD)</Text>
                  {input(startDate, setStartDate, today())}
                  <Text style={label}>DUE DATE (OPTIONAL, YYYY-MM-DD)</Text>
                  {input(dueDate, setDueDate, 'YYYY-MM-DD')}
                  <Text style={label}>NOTES</Text>
                  {input(notes, setNotes, 'Optional loan notes')}
                </>
              )}

              {modal === 'payment' && (
                <>
                  <Text style={label}>SELECT LOAN *</Text>
                  {loans.filter(l => l.balance > 0.001 && l.status !== 'cancelled').map(l => (
                    <Pressable
                      key={l.id}
                      onPress={() => setSelectedLoanId(l.id)}
                      style={choose(selectedLoanId === l.id)}
                    >
                      <Text style={{ color: '#F3F4F6', fontWeight: '700' }}>
                        {l.borrower_name} · Loan #{l.id}
                      </Text>
                      <Text style={{ color: '#AEB1B7', marginTop: 3 }}>
                        Balance: {peso(l.balance)}
                      </Text>
                    </Pressable>
                  ))}

                  <Text style={label}>PAYMENT AMOUNT (PHP) *</Text>
                  {input(paymentAmount, setPaymentAmount, 'Amount paid', true)}
                  <Text style={label}>PAYMENT DATE (YYYY-MM-DD)</Text>
                  {input(paymentDate, setPaymentDate, today())}
                  <Text style={label}>PAYMENT METHOD</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                    {['cash', 'GCash', 'bank transfer', 'other'].map(method => (
                      <Pressable
                        key={method}
                        onPress={() => setPaymentMethod(method)}
                        style={choose(paymentMethod === method)}
                      >
                        <Text style={{ color: '#F3F4F6' }}>{method}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={label}>REFERENCE NUMBER (OPTIONAL)</Text>
                  {input(reference, setReference, 'Receipt or transaction reference')}
                  <Text style={label}>NOTES</Text>
                  {input(notes, setNotes, 'Optional payment notes')}
                </>
              )}

              <Pressable
                disabled={saving}
                onPress={
                  modal === 'borrower' ? saveBorrower :
                  modal === 'loan' ? saveLoan : savePayment
                }
                style={{ ...primaryButton, marginTop: 8, opacity: saving ? 0.6 : 1 }}
              >
                <Text style={{ color: '#292B2F', fontWeight: '800' }}>
                  {saving ? 'Saving...' : 'Save'}
                </Text>
              </Pressable>

              <Pressable
                disabled={saving}
                onPress={closeModal}
                style={{ padding: 14, alignItems: 'center' }}
              >
                <Text style={{ color: '#AEB1B7', fontWeight: '700' }}>
                  Cancel
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({});
