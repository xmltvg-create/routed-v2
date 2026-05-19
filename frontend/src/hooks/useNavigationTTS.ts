/**
 * useNavigationTTS — Hook for OpenAI TTS voice announcements during navigation.
 * Calls /api/tts when turn instructions change. Plays audio via HTML5 Audio.
 * Includes client-side cache to avoid redundant API calls.
 */

import { useRef, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface UseTTSOptions {
  enabled: boolean;
  instruction: string | null;
}

export function useNavigationTTS({ enabled, instruction }: UseTTSOptions) {
  const lastSpokenRef = useRef<string>('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<string, string>>(new Map());
  const isFetchingRef = useRef(false);

  const speak = useCallback(async (text: string) => {
    if (Platform.OS !== 'web' || !text || isFetchingRef.current) return;

    // Check client cache
    let audioUrl = cacheRef.current.get(text);
    if (!audioUrl) {
      isFetchingRef.current = true;
      try {
        const res = await fetch(`${BACKEND_URL}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.audio_base64) return;
        audioUrl = `data:audio/mp3;base64,${data.audio_base64}`;
        // Cache locally (limit 50)
        if (cacheRef.current.size > 50) {
          const first = cacheRef.current.keys().next().value;
          if (first) cacheRef.current.delete(first);
        }
        cacheRef.current.set(text, audioUrl);
      } catch (e) {
        console.error('[TTS] fetch failed:', e);
        return;
      } finally {
        isFetchingRef.current = false;
      }
    }

    // Stop any playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.play().catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled || !instruction || Platform.OS !== 'web') return;
    // Only speak when instruction changes
    if (instruction === lastSpokenRef.current) return;
    lastSpokenRef.current = instruction;
    speak(instruction);
  }, [enabled, instruction, speak]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);
}
