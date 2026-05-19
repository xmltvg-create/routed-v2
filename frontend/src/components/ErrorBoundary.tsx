/**
 * ErrorBoundary — catches any uncaught render/runtime error in descendants and
 * shows a visible error UI instead of a black screen. Critical for Android EAS
 * release builds where silent JS crashes otherwise produce a blank navy (#0f172a)
 * screen with no diagnostic info.
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ info });
    // Also log to JS console so `adb logcat | grep ReactNativeJS` can see it
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ScrollView
        style={styles.wrap}
        contentContainerStyle={styles.content}
        data-testid="error-boundary-screen"
      >
        <Text style={styles.title}>Something crashed</Text>
        <Text style={styles.subtitle}>
          The app hit an unhandled error. Share this with support to help diagnose.
        </Text>
        <View style={styles.card}>
          <Text style={styles.label}>Message</Text>
          <Text style={styles.message} selectable>
            {this.state.error.message || String(this.state.error)}
          </Text>
        </View>
        {this.state.error.stack ? (
          <View style={styles.card}>
            <Text style={styles.label}>Stack</Text>
            <Text style={styles.mono} selectable>
              {this.state.error.stack}
            </Text>
          </View>
        ) : null}
        {this.state.info?.componentStack ? (
          <View style={styles.card}>
            <Text style={styles.label}>Component stack</Text>
            <Text style={styles.mono} selectable>
              {this.state.info.componentStack}
            </Text>
          </View>
        ) : null}
        <TouchableOpacity style={styles.btn} onPress={this.reset}>
          <Text style={styles.btnText}>Try again</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 20, paddingTop: 60 },
  title: { color: '#fbbf24', fontSize: 22, fontWeight: '800', marginBottom: 6 },
  subtitle: { color: '#94a3b8', fontSize: 13, marginBottom: 18 },
  card: {
    backgroundColor: 'rgba(30,41,59,0.8)',
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(71,85,105,0.4)',
  },
  label: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  message: { color: '#fecaca', fontSize: 14, fontWeight: '600' },
  mono: { color: '#cbd5e1', fontSize: 11, fontFamily: 'monospace' },
  btn: {
    marginTop: 10,
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
