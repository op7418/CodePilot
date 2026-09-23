'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';

interface WordItem {
  text: string;
  color: string;
}

const WORDS_EN: WordItem[] = [
  { text: 'Development', color: 'currentColor' },
  { text: 'Design', color: 'currentColor' },
  { text: 'Writing', color: 'currentColor' },
  { text: 'Research', color: 'currentColor' },
  { text: 'Debugging', color: 'currentColor' },
  { text: 'Prototyping', color: 'currentColor' },
];

const WORDS_ZH: WordItem[] = [
  { text: '开发', color: 'currentColor' },
  { text: '设计', color: 'currentColor' },
  { text: '写作', color: 'currentColor' },
  { text: '调研', color: 'currentColor' },
  { text: '调试', color: 'currentColor' },
  { text: '原型', color: 'currentColor' },
];

export function TypewriterWords({ locale }: { locale: string }) {
  const words = locale === 'zh' ? WORDS_ZH : WORDS_EN;
  const [index, setIndex] = useState(0);
  const [displayed, setDisplayed] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const current = words[index];

  const tick = useCallback(() => {
    const full = current.text;

    if (!isDeleting) {
      // Typing
      const next = full.slice(0, displayed.length + 1);
      setDisplayed(next);
      if (next === full) {
        // Pause then start deleting
        setTimeout(() => setIsDeleting(true), 2000);
        return;
      }
    } else {
      // Deleting
      const next = full.slice(0, displayed.length - 1);
      setDisplayed(next);
      if (next === '') {
        setIsDeleting(false);
        setIndex((prev) => (prev + 1) % words.length);
        return;
      }
    }
  }, [current.text, displayed, isDeleting, words.length]);

  useEffect(() => {
    const speed = isDeleting ? 60 : 100;
    const timer = setTimeout(tick, speed);
    return () => clearTimeout(timer);
  }, [tick, isDeleting]);

  return (
    <span className="inline-flex items-baseline">
      <span
        className="font-semibold transition-colors duration-300"
        style={{ color: current.color }}
      >
        {displayed}
      </span>
      <motion.span
        className="ml-[1px] inline-block h-[0.85em] w-[2px] translate-y-[0.05em] rounded-full"
        style={{ backgroundColor: current.color }}
        animate={{ opacity: [1, 0] }}
        transition={{ duration: 0.6, repeat: Infinity, repeatType: 'reverse' }}
      />
    </span>
  );
}
