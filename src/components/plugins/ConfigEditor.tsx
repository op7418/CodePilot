'use client';

import { useState, useEffect } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/hooks/useTranslation';

interface ConfigEditorProps {
  value: string;
  onSave: (value: string) => void;
  label?: string;
}

export function ConfigEditor({ value, onSave, label }: ConfigEditorProps) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => { setText(value); }, [value]);

  function handleSave() {
    try {
      JSON.parse(text);
      setError(null);
      onSave(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('configEditor.invalidJson'));
    }
  }

  function handleFormat() {
    try {
      const parsed = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('configEditor.invalidJson'));
    }
  }

  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className="font-mono text-sm min-h-[200px]"
        placeholder="{}"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave}>
          {t('configEditor.save')}
        </Button>
        <Button size="sm" variant="outline" onClick={handleFormat}>
          {t('configEditor.format')}
        </Button>
      </div>
    </div>
  );
}
